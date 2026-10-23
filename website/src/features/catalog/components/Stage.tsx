export function Stage() {
  return (
    <div className="stage" aria-hidden="true">
      <div className="stage-orbit" />
      <div className="stage-window">
        <div className="stage-top">
          <span className="stage-dots">
            <i />
            <i />
            <i />
          </span>
          <strong>菜播·录包机</strong>
          <span>v0.2.2</span>
        </div>
        <div className="stage-body">
          <aside>
            <p>房间</p>
            <div className="room is-live">
              <b>晚间歌回</b>
              <span>B 站 · 录制中</span>
            </div>
            <div className="room">
              <b>午后闲聊</b>
              <span>抖音 · 等待开播</span>
            </div>
          </aside>
          <div className="stage-main">
            <div className="stage-meta">
              <span>2026.10.13</span>
              <span>21:30 — 22:10</span>
            </div>
            <svg className="wave" viewBox="0 0 320 72" preserveAspectRatio="none">
              <path
                d="M0 46 C18 46 18 18 36 18 C54 18 54 52 72 52 C90 52 96 28 114 26 C132 24 140 58 158 54 C176 50 184 16 204 20 C224 24 230 48 248 44 C266 40 274 22 292 28 C306 32 312 40 320 38 L320 72 L0 72 Z"
                fill="rgba(231,168,184,0.28)"
              />
              <path
                d="M0 46 C18 46 18 18 36 18 C54 18 54 52 72 52 C90 52 96 28 114 26 C132 24 140 58 158 54 C176 50 184 16 204 20 C224 24 230 48 248 44 C266 40 274 22 292 28 C306 32 312 40 320 38"
                fill="none"
                stroke="#e7a8b8"
                strokeWidth="1.6"
              />
            </svg>
            <div className="density">
              {Array.from({ length: 28 }, (_, index) => (
                <i key={index} style={{ height: `${10 + ((index * 17) % 26)}px` }} />
              ))}
            </div>
            <div className="stage-range">
              <span>入点 21:33</span>
              <em>2 分钟</em>
              <span>出点 21:35</span>
            </div>
          </div>
        </div>
      </div>
      <div className="float-card float-a">边录边剪</div>
      <div className="float-card float-b">弹幕版 · 纯净版</div>
    </div>
  )
}
