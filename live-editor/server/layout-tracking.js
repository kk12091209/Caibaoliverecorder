// Connection-local revision: no persisted event log or per-message writes.
// Normal appends use rowid/count checkpoints; historical edits and filter
// retractions invalidate them. PRAGMA data_version covers other connections.
export function installLayoutTracking(store) {
  store.layoutRevision = 0;
  store.layoutContentRevision = 0;
  store.db.function('layout_changed', kind => {
    store.layoutRevision++;
    // Final block validation already snapshots its own filter flags. A flag
    // for future comments must not invalidate old pixels; text edits still do.
    if(kind==='message')store.layoutContentRevision++;
    return 0;
  });
  store.db.exec(`
    CREATE TEMP TRIGGER layout_message_update AFTER UPDATE ON main.danmaku
      BEGIN SELECT layout_changed('message'); END;
    CREATE TEMP TRIGGER layout_message_delete AFTER DELETE ON main.danmaku
      BEGIN SELECT layout_changed('message'); END;
    CREATE TEMP TRIGGER layout_message_replace BEFORE INSERT ON main.danmaku
      WHEN EXISTS(SELECT 1 FROM danmaku WHERE id=NEW.id OR rowid=NEW.rowid)
      BEGIN SELECT layout_changed('message'); END;
    CREATE TEMP TRIGGER layout_filter_insert AFTER INSERT ON main.danmaku_filters
      BEGIN SELECT layout_changed('filter'); END;
    CREATE TEMP TRIGGER layout_filter_update AFTER UPDATE ON main.danmaku_filters
      BEGIN SELECT layout_changed('filter'); END;
    CREATE TEMP TRIGGER layout_filter_delete AFTER DELETE ON main.danmaku_filters
      BEGIN SELECT layout_changed('filter'); END;
  `);
}
