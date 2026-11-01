import {randomUUID} from 'node:crypto';
import {DouyinUserDiscovery,decimal} from './douyin-user-discovery.js';

export class DouyinUserFollow{
  constructor(store,{recorder,discovery=new DouyinUserDiscovery({resolver:recorder.resolver,request:recorder.request}),now=Date.now,pollMs=15000,exitMs=15000,lostMs=180000,maxFollowMs=4*60*60*1000}={}){
    Object.assign(this,{store,recorder,discovery,now,pollMs,exitMs,lostMs,maxFollowMs});this.targets=new Map();this.closed=false;this.paused=false;this.started=false;
    store.run('CREATE TABLE IF NOT EXISTS douyin_follow_intervals(id TEXT PRIMARY KEY,uid TEXT NOT NULL,name TEXT NOT NULL,web_rid TEXT NOT NULL,room_id TEXT NOT NULL,host TEXT NOT NULL,discovered INTEGER NOT NULL,started INTEGER,ended INTEGER,reason TEXT NOT NULL DEFAULT \'\')');
    if(!store.all('PRAGMA table_info(douyin_follow_intervals)').some(c=>c.name==='kind'))store.run("ALTER TABLE douyin_follow_intervals ADD COLUMN kind TEXT NOT NULL DEFAULT 'guest'");
    store.run('CREATE TABLE IF NOT EXISTS douyin_follow_materials(interval TEXT NOT NULL REFERENCES douyin_follow_intervals(id) ON DELETE CASCADE,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(interval,session))');
    store.run("UPDATE douyin_follow_intervals SET ended=?,reason='应用重启，重新核验' WHERE ended IS NULL",now());
    store.run('CREATE INDEX IF NOT EXISTS douyin_follow_user_time ON douyin_follow_intervals(uid,discovered DESC)');
    const savedUsers=store.setting('douyin-follow-users');
    for(const saved of Array.isArray(savedUsers)?savedUsers:[]){const uid=decimal(saved?.uid);if(!uid||this.targets.size>=64)continue;this.targets.set(uid,{uid,name:String(saved.name||'抖音用户').slice(0,100),secUid:String(saved.secUid||''),profile:String(saved.profile||''),ownWebRid:decimal(saved.ownWebRid),enabled:saved.enabled===true,generation:0,nextAt:0,state:saved.enabled?'监控中，等待开播或连麦':'已停止',failures:0});}
    recorder.followCaptured=room=>{for(const target of this.targets.values())if(target.active?.webRid===room.webRid)this.attachMaterial(target);};
  }
  get snapshot(){return [...this.targets.values()].map(target=>({uid:target.uid,name:target.name,profile:target.profile,ownWebRid:target.ownWebRid||'',enabled:target.enabled,state:target.state,kind:target.active?.kind||'',webRid:target.active?.webRid||'',host:target.active?.host||'',recording:!!target.active&&!!this.recorder.entries.get(target.active.webRid)?.recording,error:this.recorder.entries.get(target.active?.webRid)?.error||'',chatError:this.recorder.entries.get(target.active?.webRid)?.chatError||'',history:this.store.all('SELECT * FROM douyin_follow_intervals WHERE uid=? ORDER BY discovered DESC LIMIT 10',target.uid).map(row=>({...row,materials:this.store.all('SELECT session FROM douyin_follow_materials WHERE interval=?',row.id).map(item=>item.session)}))}));}
  save(){this.store.setting('douyin-follow-users',[...this.targets.values()].map(({uid,secUid,name,profile,ownWebRid,enabled})=>({uid,secUid,name,profile,ownWebRid,enabled})));}
  register(identity,{enabled=false}={}){
    if(this.closed)throw Error('录制服务已关闭。');if(!decimal(identity?.uid))throw Error('主播身份无效。');
    let target=this.targets.get(identity.uid);
    if(!target){if(this.targets.size>=64)throw Error('最多同时监控64个抖音主播。');target={...identity,enabled,generation:0,nextAt:0,state:enabled?'监控中，等待开播或连麦':'已停止',failures:0};this.targets.set(identity.uid,target);}
    else {for(const key of ['name','secUid','profile','ownWebRid'])if(identity[key])target[key]=identity[key];}
    this.save();return target;
  }
  async add(input){
    if(this.closed)throw Error('录制服务已关闭。');
    const identity=await this.discovery.identity(input,{signal:AbortSignal.timeout(20000)});
    this.register(identity);
    return this.snapshot.find(target=>target.uid===identity.uid);
  }
  async addAnchor(input){
    const identity=await this.discovery.monitorIdentity(input,{signal:AbortSignal.any([this.recorder.shutdown.signal,AbortSignal.timeout(20000)])});
    const target=this.register(identity,{enabled:true});if(target.enabled)void this.poll().catch(()=>{});
    return this.snapshot.find(item=>item.uid===identity.uid);
  }
  start(){if(this.closed||this.started)return;this.started=true;this.schedule();}
  schedule(){if(this.closed||this.paused||!this.started||this.timer)return;this.timer=setTimeout(async()=>{this.timer=null;try{await this.poll();}catch{this.store.diagnostics?.record('连麦跟录','监控循环暂时失败，将继续重试。',{level:'警告'});}finally{this.schedule();}},1000);this.timer.unref?.();}
  async enable(uid,enabled){
    const target=this.targets.get(uid);if(!target||this.closed)throw Error('跟随用户不存在。');if(typeof enabled!=='boolean')throw Error('请明确选择是否开启监控。');
    target.enabled=enabled;target.generation++;target.abort?.abort();target.nextAt=0;target.failures=0;target.exitSince=null;target.exitCount=0;this.save();
    if(!enabled)await this.finish(target,'用户停止');target.state=enabled?'监控中，等待开播或连麦':'已停止';
    if(enabled)void this.poll().catch(()=>{});
  }
  async remove(uid,confirmed){if(confirmed!==true)throw Error('请确认移除跟随用户。');await this.enable(uid,false);this.targets.delete(uid);this.save();}
  attachMaterial(target){
    if(!target.active)return;const room=this.recorder.entries.get(target.active.webRid);
    if(room?.session&&room.actualRoom===target.active.roomId){this.store.run('INSERT OR IGNORE INTO douyin_follow_materials(interval,session) VALUES(?,?)',target.active.id,room.session);if(room.recording)this.store.run('UPDATE douyin_follow_intervals SET started=COALESCE(started,?) WHERE id=?',this.now(),target.active.id);}
  }
  async finish(target,reason){
    const active=target.active;if(!active)return;this.attachMaterial(target);target.active=null;target.exitCount=0;target.exitSince=null;
    this.store.run('UPDATE douyin_follow_intervals SET ended=?,reason=? WHERE id=?',this.now(),reason,active.id);
    await this.recorder.releaseFollow(target.uid,active.webRid);
  }
  async check(target,verified){
    const version=target.generation,controller=new AbortController();target.abort=controller;
    const current=()=>!this.closed&&!this.paused&&target.enabled&&target.generation===version&&this.targets.get(target.uid)===target;
    try{
      const result=verified||await this.discovery.observe(target.uid,{ownWebRid:target.ownWebRid,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});if(!current())return;
      target.failures=0;target.nextAt=this.now()+(target.active?this.pollMs:30000);this.attachMaterial(target);
      if(result.state==='guest-confirmed'||result.state==='self-live'&&result.metadata){
        const m=result.metadata,kind=result.state==='self-live'?'self':'guest';if(!decimal(m?.webRid)||!decimal(m?.roomId)||!m.streaming||!m.stream||(m.ownerId===target.uid)!==(kind==='self'))throw Error('invalid verified room');
        if(kind==='self'&&(target.ownWebRid!==m.webRid||target.name!==m.name)){target.ownWebRid=m.webRid;target.name=m.name;this.save();}
        target.lastVerified=this.now();target.exitCount=0;target.exitSince=null;
        if(!target.active||target.active.webRid!==m.webRid||target.active.roomId!==m.roomId){
          const previous=target.active;
          // Start the verified destination before waiting for the old file to close.
          if(previous?.webRid===m.webRid){await this.finish(target,'直播场次变化');if(!current())return;await this.recorder.acquireFollow(target.uid,m,current);}
          else {await this.recorder.acquireFollow(target.uid,m,current);if(previous){await this.finish(target,'切换直播间');if(!current()){await this.recorder.releaseFollow(target.uid,m.webRid);return;}}}
          if(!current()){await this.recorder.releaseFollow(target.uid,m.webRid);return;}
          const id=randomUUID();target.active={id,webRid:m.webRid,roomId:m.roomId,host:m.name,kind,since:this.now()};
          this.store.run('INSERT INTO douyin_follow_intervals(id,uid,name,web_rid,room_id,host,discovered,kind) VALUES(?,?,?,?,?,?,?,?)',id,target.uid,target.name,m.webRid,m.roomId,m.name,this.now(),kind);
        }
        this.attachMaterial(target);target.state=kind==='self'?'本人直播中':'连麦跟录中';target.nextAt=this.now()+this.pollMs;
      }else if(result.state==='offline-observation'||result.state==='self-live'){
        target.exitCount=(target.exitCount||0)+1;target.exitSince??=this.now();
        target.state=result.state==='self-live'?'本人开播，等待可录制画面':'监控中，等待开播或连麦';
        if(target.active){target.state='疑似结束，等待再次确认';target.nextAt=this.now()+this.pollMs;if(target.exitCount>=2&&this.now()-target.exitSince>=this.exitMs)await this.finish(target,result.state==='self-live'?'转为本人开播':target.active.kind==='self'?'确认直播结束':'确认退出连麦');}
      }else{target.exitCount=0;target.exitSince=null;target.state='待确认：'+String(result.reason||'状态暂时不可用').slice(0,100);}
    }catch{
      if(!current())return;target.exitCount=0;target.exitSince=null;target.failures=Math.min(4,target.failures+1);target.nextAt=this.now()+Math.min(120000,this.pollMs*2**target.failures);target.state='待确认：查询失败，稍后重试';
    }finally{
      if(target.abort===controller)target.abort=null;
      if(current()&&target.active){
        if(target.active.kind==='guest'&&this.now()-target.active.since>=this.maxFollowMs){await this.finish(target,'达到单次跟录4小时上限');target.enabled=false;target.state='已达单次时长上限，请重新开启';this.save();}
        else if(this.now()-(target.lastVerified??target.active.since)>=this.lostMs){await this.finish(target,'状态失联保护');target.state='状态失联，已停止录像，继续监控';}
      }
    }
  }
  poll(force=false){
    if(this.closed||this.paused||!this.started)return Promise.resolve();if(this.polling)return this.polling;
    this.polling=(async()=>{const targets=[...this.targets.values()].filter(target=>target.enabled&&(force||this.now()>=target.nextAt));let cursor=0;
      const work=async()=>{while(cursor<targets.length&&!this.closed&&!this.paused)await this.check(targets[cursor++]);};await Promise.all([work(),work()]);
    })().finally(()=>this.polling=null);return this.polling;
  }
  async pauseRoom(webRid){for(const target of this.targets.values())if(target.active?.webRid===webRid)await this.enable(target.uid,false);}
  async pause(){this.paused=true;clearTimeout(this.timer);this.timer=null;for(const target of this.targets.values())target.abort?.abort();await this.polling;}
  resume(){if(this.closed)return;this.paused=false;for(const target of this.targets.values())target.nextAt=0;this.schedule();}
  async close(){if(this.closed)return;this.closed=true;await this.pause();for(const target of this.targets.values())await this.finish(target,'应用退出');this.recorder.followCaptured=null;}
}
