import fs from 'node:fs/promises';
import {normalizedDanmakuStyle,savedDanmakuStyle} from '../shared/danmaku-style.js';
import {chatRate} from './chat-rules.js';
import {exportedJobFile} from './output-names.js';
import {messageEditsKey} from '../shared/message-edits.js';

const renderingKey = edit => JSON.stringify([[...new Set(edit.excluded||[])].sort(),edit.filterLottery!==false,edit.font?.id||null,normalizedDanmakuStyle(edit.danmakuStyle),edit.danmakuPerSecond??50,messageEditsKey(edit.messageEdits)]);

// Connection-local change tracking also sees SQL issued by deletion/recovery.
// It stores no extra user data on disk and is rebuilt when the service starts.
export class PreparationReconciliation {
  constructor(owner,{batchSize=25,sweepMs=30000}={}) {
    this.owner=owner;this.store=owner.store;this.batchSize=batchSize;this.sweepMs=sweepMs;
    this.nextSweep=owner.now()+sweepMs;this.cursor=null;this.running=null;
    const db=this.store.db;
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS preparation_export_dirty(session TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS temp.preparation_export_priority ON preparation_export_dirty(priority DESC);
      DELETE FROM preparation_export_dirty;
      INSERT INTO preparation_export_dirty(session,priority) SELECT session,0 FROM preparation_jobs;`);
    const mark=value=>`INSERT INTO preparation_export_dirty(session) SELECT ${value} WHERE ${value} IS NOT NULL ON CONFLICT(session) DO UPDATE SET generation=generation+1,priority=1;`;
    const done=value=>`${value}.status='done' AND ${value}.mode IN ('danmaku','dual')`;
    const triggers={
      job_insert:`AFTER INSERT ON main.jobs WHEN ${done('NEW')} BEGIN ${mark('NEW.session')} END`,
      job_update:`AFTER UPDATE OF session,status,mode,file,data ON main.jobs WHEN (${done('NEW')}) OR (${done('OLD')}) BEGIN ${mark('OLD.session')} ${mark('NEW.session')} END`,
      job_delete:`AFTER DELETE ON main.jobs WHEN ${done('OLD')} BEGIN ${mark('OLD.session')} END`,
      edit_insert:`AFTER INSERT ON main.edits BEGIN ${mark('NEW.session')} END`,
      edit_update:`AFTER UPDATE ON main.edits BEGIN ${mark('NEW.session')} END`,
      edit_delete:`AFTER DELETE ON main.edits BEGIN ${mark('OLD.session')} END`,
      session_update:`AFTER UPDATE OF status,duration,deleted_at ON main.sessions WHEN NEW.status='finished' OR OLD.status='finished' BEGIN ${mark('NEW.id')} END`,
      preparation_insert:`AFTER INSERT ON main.preparation_jobs BEGIN ${mark('NEW.session')} END`,
    };
    for(const [name,definition]of Object.entries(triggers))db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS prep_reconcile_${name} ${definition}`);
    this.triggers=Object.keys(triggers);
    this.styleKey=this.currentStyle();
  }
  currentStyle(){return renderingKey({font:this.owner.media.fonts?.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store)});}
  mark(id,priority=1){this.store.run('INSERT INTO preparation_export_dirty(session,priority) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET generation=generation+1,priority=MAX(priority,excluded.priority)',id,priority);}
  tick(){
    if(this.owner.closed)return Promise.resolve();
    return this.running??=(this.drain().finally(()=>{this.running=null;}));
  }
  async drain(){
    const key=this.currentStyle();
    if(key!==this.styleKey){this.styleKey=key;this.store.run('INSERT OR IGNORE INTO preparation_export_dirty(session) SELECT session FROM preparation_jobs');}
    // External deletion of an exported file has no database event. Recheck a
    // bounded page per tick, with a quiet interval between complete passes.
    if(this.cursor!==null||this.owner.now()>=this.nextSweep){
      const rows=this.store.all("SELECT session FROM preparation_jobs WHERE status='exported' AND session>? ORDER BY session LIMIT ?",this.cursor??'',this.batchSize);
      for(const row of rows)this.mark(row.session,0);
      this.cursor=rows.length===this.batchSize?rows.at(-1).session:null;
      if(this.cursor===null)this.nextSweep=this.owner.now()+this.sweepMs;
    }
    const rows=this.store.all('SELECT session,generation FROM preparation_export_dirty ORDER BY priority DESC,rowid LIMIT ?',this.batchSize);
    for(const row of rows){
      if(this.owner.closed)return;
      this.store.run('DELETE FROM preparation_export_dirty WHERE session=? AND generation=?',row.session,row.generation);
      try{await this.check(row.session);}catch(error){this.mark(row.session);throw error;}
    }
  }
  async check(id) {
    // A finished full baked export fulfils the user's need, even when its
    // missing parts were rendered directly rather than added to render-cache.
    const owner=this.owner;
    if(owner.closed||!owner.row(id))return;
    if(!owner.available(id)){if(this.store.session(id))this.mark(id);return;}
    if(this.store.session(id).status!=='finished')return;
    {
      const session=this.store.session(id),currentKey=renderingKey({...this.store.edit(id),font:this.owner.media.fonts?.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store)});
      let matched=false;
      for(const job of this.store.all("SELECT * FROM jobs WHERE session=? AND status='done' AND mode IN ('danmaku','dual') ORDER BY created DESC",id)) {
        let data;try{data=JSON.parse(job.data);}catch{continue;}
        if(data.scope!=='full'||data.ranges?.length!==1||data.ranges[0].start!==0||Math.abs(data.ranges[0].end-session.duration)>.001||renderingKey(data)!==currentKey)continue;
        const file=exportedJobFile(job,'danmaku');if(!file)continue;
        try {const stat=await fs.stat(file);if(!stat.isFile()||stat.size<=0)continue;} catch {continue;}
        if(this.owner.closed||!this.owner.available(id))return;
        // Recheck after I/O: deletion/editing may have changed the evidence.
        const currentJob=this.store.get('SELECT status,data FROM jobs WHERE id=?',job.id);
        if(currentJob?.status!=='done'||currentJob.data!==job.data||renderingKey({...this.store.edit(id),font:this.owner.media.fonts?.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store)})!==currentKey)continue;
        await this.owner.interrupt('exported',id);
        if(this.owner.closed||!this.owner.available(id)||renderingKey({...this.store.edit(id),font:this.owner.media.fonts?.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store)})!==currentKey)return;
        this.store.run("UPDATE preparation_jobs SET status='exported',reason='',error='',paused=0,next_retry=0,updated=? WHERE session=? AND status!='exported'",this.owner.stamp(),id);
        matched=true;break;
      }
      if(!matched&&this.owner.row(id)?.status==='exported')this.store.run("UPDATE preparation_jobs SET status='queued',reason='',updated=? WHERE session=?",this.owner.stamp(),id);
    }
  }
  async close(){
    await this.running;
    for(const name of this.triggers)this.store.db.exec(`DROP TRIGGER IF EXISTS temp.prep_reconcile_${name}`);
    this.store.db.exec('DROP TABLE IF EXISTS temp.preparation_export_dirty');
  }
}
