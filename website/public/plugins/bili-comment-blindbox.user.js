// ==UserScript==
// @name         B站评论盲盒防护
// @namespace    local.bili-comment-blindbox
// @version      0.20.0
// @description  B站评论防护；最多同时跟车三人，不改动输入草稿；支持托管遮挡，以及按直播间保存、独立摄像头同步生效的画面调色和曲线预设
// @icon         https://greasyfork.org/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6MzAyMjM5LCJwdXIiOiJibG9iX2lkIn19--a019e368236259cf0fa8584eaa5b528506cbfe76/2561766c7692aa66dd67b4e252602fa51669777785.jpg?locale=zh-CN
// @homepageURL  https://greasyfork.org/zh-CN/scripts/585978
// @supportURL   https://greasyfork.org/zh-CN/scripts/585978/feedback
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/opus/*
// @match        https://t.bilibili.com/
// @match        https://t.bilibili.com/*
// @match        https://message.bilibili.com/*
// @match        https://live.bilibili.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  "use strict";

  // 直播页面使用独立模块，避免评论遮罩影响弹幕和原生菜单。
  if (location.hostname === "live.bilibili.com") {
    if (/^\/(?:blanc\/)?\d+(?:\/|$)/.test(location.pathname)) installLiveFollow();
    return;
  }

  const CFG = {
    enabledKey: "bcp.enabled.v4",
    languageKey: "bcp.language.v1",
    petKey: "bcp.pet.v1",
    sendInterceptKey: "bcp.sendIntercept.v1",
    enabledCookie: "bcp_global_enabled_v2",
    languageCookie: "bcp_global_language_v2",
    petCookie: "bcp_global_pet_v1",
    sendInterceptCookie: "bcp_global_send_intercept_v1",
    legacyEnabledCookie: "bcp_enabled",
    legacyLanguageCookie: "bcp_language",
    defaultEnabled: true,
    defaultSendIntercept: false,
    defaultLanguage: "zh",
    defaultPet: "cat",
    hoverDelay: 2000,
    nameMaskChar: "◆",
    maxNameMaskLength: 4,
    maxCommentMaskLength: 20,
    sendInterceptMaskLength: 20,
  };

  const PETS = {
    cat: { name: "猫", sound: "喵" },
    dog: { name: "狗", sound: "汪" },
    frog: { name: "青蛙", sound: "呱" },
    cow: { name: "牛", sound: "哞" },
    sheep: { name: "羊", sound: "咩" },
  };

  const hasGMStorage =
    typeof GM_getValue === "function" && typeof GM_setValue === "function";

  expireHostCookie(CFG.enabledCookie);
  expireHostCookie(CFG.languageCookie);
  expireHostCookie(CFG.petCookie);
  expireHostCookie(CFG.sendInterceptCookie);

  let enabled = readSharedState(
    CFG.enabledCookie,
    CFG.enabledKey,
    CFG.legacyEnabledCookie,
  );
  enabled = enabled === null ? CFG.defaultEnabled : enabled === "1";
  let language =
    readSharedState(
      CFG.languageCookie,
      CFG.languageKey,
      CFG.legacyLanguageCookie,
    ) || CFG.defaultLanguage;
  if (!["zh", "ko", "en", "ja"].includes(language))
    language = CFG.defaultLanguage;
  let pet =
    readSharedState(CFG.petCookie, CFG.petKey) || CFG.defaultPet;
  if (!Object.prototype.hasOwnProperty.call(PETS, pet)) pet = CFG.defaultPet;
  let sendInterceptEnabled = readSharedState(
    CFG.sendInterceptCookie,
    CFG.sendInterceptKey,
  );
  sendInterceptEnabled =
    sendInterceptEnabled === null
      ? CFG.defaultSendIntercept
      : sendInterceptEnabled === "1";
  initializeSharedState(CFG.enabledCookie, CFG.enabledKey, enabled ? "1" : "0");
  initializeSharedState(CFG.languageCookie, CFG.languageKey, language);
  initializeSharedState(CFG.petCookie, CFG.petKey, pet);
  initializeSharedState(
    CFG.sendInterceptCookie,
    CFG.sendInterceptKey,
    sendInterceptEnabled ? "1" : "0",
  );

  const I18N = {
    zh: {
      on: "评论防护：开",
      off: "评论防护：关",
      commentMask: "喵",
      imageMask: "点击查看图片",
      sendInterceptOn: "发送拦截：开",
      sendInterceptOff: "发送拦截：关",
    },
    ko: {
      on: "댓글 보호: 켬",
      off: "댓글 보호: 끔",
      commentMask: "야옹",
      imageMask: "이미지 보기",
      sendInterceptOn: "전송 가로채기: 켬",
      sendInterceptOff: "전송 가로채기: 끔",
    },
    en: {
      on: "Comment Shield: On",
      off: "Comment Shield: Off",
      commentMask: "meow",
      imageMask: "View image",
      sendInterceptOn: "Send Intercept: On",
      sendInterceptOff: "Send Intercept: Off",
    },
    ja: {
      on: "コメント防護：オン",
      off: "コメント防護：オフ",
      commentMask: "にゃ",
      imageMask: "画像を見る",
      sendInterceptOn: "送信インターセプト：オン",
      sendInterceptOff: "送信インターセプト：オフ",
    },
  };

  installSendInterceptHook();
  syncSendInterceptBridgeState();

  const avatarSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <rect width="80" height="80" rx="40" fill="#e5e7eb"/>
      <circle cx="40" cy="30" r="14" fill="#9ca3af"/>
      <path d="M18 66c4-16 16-24 22-24s18 8 22 24" fill="#9ca3af"/>
    </svg>`;
  const MASK_AVATAR =
    "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(avatarSvg);

  const SCOPE_SELECTOR = [
    "#comment",
    "#commentapp",
    ".comment",
    ".comment-m",
    ".comment-area",
    ".comment-section",
    ".comment-container",
    ".bili-comment-container",
    ".bili-comments",
    "bili-comments",
    ".comment-list",
    ".reply-list",
    ".reply-wrap",
    ".reply-warp",
    ".bb-comment",
    ".comment-module",
    ".opus-module-comment",
    ".bili-dyn-item__comment",
    ".bili-dyn-comment",
    "bili-comment-thread-renderer",
    "bili-comment-renderer",
    ".message-list",
    ".message-list-content",
    ".message-content",
    ".message-item",
    ".interaction-item__content",
    ".interaction-item__title",
    ".interaction-item__msg",
    ".interaction-item__reference",
    ".interaction-item__cover",
    ".at-item",
    ".chat-history",
    ".chat-content",
    ".im-container",
    '[class*="_ChatWindow_"]',
    '[class*="_ChatContent_"]',
    '[class*="_MessageList_"]',
    '[class*="_SessionList_"]',
    ".msg-list",
    ".msg-item",
    ".talk-item",
    ".notify-list",
    ".notify-item",
    "#message-list",
    "#link-message-container",
  ].join(",");

  const COMMENT_ITEM_SELECTOR = [
    ".list-item",
    ".reply-item",
    ".sub-reply-item",
    ".reply-wrap",
    ".reply-card",
    ".root-reply-container",
    ".sub-reply-container",
    ".bili-comment-item",
    ".bili-comment-renderer",
    ".message-item",
    ".reply-item",
    ".at-item",
    ".msg-item",
    ".talk-item",
    ".list-item",
    "bili-comment-renderer",
    "bili-comment-thread-renderer",
  ].join(",");

  const AVATAR_BOX_SELECTOR = [
    ".user-face",
    ".reply-face",
    ".face",
    ".avatar",
    ".bili-avatar",
    ".root-reply-avatar",
    ".sub-reply-avatar",
    ".bili-comment-avatar",
    "#user-avatar",
    "a[data-user-profile-id]",
    "a[data-user-profile-spmid-follow]",
    "bili-avatar",
    ".message-list .avatar",
    ".message-item .avatar",
    ".msg-item .avatar",
    ".talk-item .avatar",
    ".list-item .avatar",
    ".interaction-item__avatar",
    '.im-container [class*="_Avatar_"]',
    ".im-container .b-img--face",
    'a[href*="space.bilibili.com"][class*="avatar"]',
    '[class*="avatar"][class*="reply"]',
    '[class*="face"][class*="reply"]',
  ].join(",");

  const AVATAR_IMG_SELECTOR = [
    ".user-face img",
    ".reply-face img",
    ".face img",
    ".avatar img",
    ".bili-avatar img",
    ".root-reply-avatar img",
    ".sub-reply-avatar img",
    ".bili-comment-avatar img",
    "bili-avatar img",
    ".message-list .avatar img",
    ".message-item .avatar img",
    ".msg-item .avatar img",
    ".talk-item .avatar img",
    ".list-item .avatar img",
    ".interaction-item__avatar img",
    '.im-container [class*="_Avatar_"] img',
    ".im-container .b-img--face img",
    "img.bili-avatar-img",
    "img.avatar",
    'img[src*="/bfs/face/"]',
    'img[data-src*="/bfs/face/"]',
    'img[srcset*="/bfs/face/"]',
  ].join(",");

  const NAME_SELECTOR = [
    ".user-name",
    ".sub-user-name",
    ".reply-author-name",
    ".bili-comment-user-name",
    ".name",
    ".uname",
    ".member-name",
    ".user .name",
    ".con > .user .name",
    ".con > .name",
    'a.name[href*="space.bilibili.com"]',
    'a[data-type="mention"][data-user-profile-id]',
    'a[data-type="mention"][href*="space.bilibili.com"]',
    'a[href*="space.bilibili.com"]',
    ".message-list .name",
    ".message-list .nickname",
    ".message-item .name",
    ".message-item .nickname",
    ".msg-item .name",
    ".msg-item .nickname",
    ".talk-item .name",
    ".talk-item .nickname",
    ".list-item .name",
    ".list-item .nickname",
    ".interaction-item__uname",
    '.im-container [class*="_SessionItem__Name_"]',
    '.im-container [class*="_ContactName_"]',
    '[class*="nickname"]',
  ].join(",");

  const CONTENT_SELECTOR = [
    ".reply-content",
    ".reply-content-container",
    ".root-reply-content",
    ".sub-reply-content",
    ".bili-comment-content",
    ".bili-comment-content-renderer",
    "bili-rich-text",
    "#content",
    ".comment-content",
    ".dyn-comment-content",
    ".text-con",
    ".reply-con .text-con",
    ".con > .text",
    ".con .text",
    ".comment-list .list-item .con .text",
    ".reply-list .reply-item .text",
    ".list-item .text",
    ".reply-item .text",
    ".sub-reply-item .text",
    "p.text",
    "span.text",
    '[class*="reply-content"]',
    '[class*="comment-content"]',
  ].join(",");

  const EXCLUDE_SELECTOR = [
    "script",
    "style",
    "textarea",
    "input",
    "button",
    '[contenteditable="true"]',
    ".info",
    ".reply-info",
    ".sub-reply-info",
    ".operation",
    ".comment-actions",
    ".toolbar",
    ".action",
    ".delete",
    ".del",
    ".operate",
    ".operation",
    ".like",
    ".hate",
    ".reply-btn",
    '[class*="delete"]',
    '[class*="operate"]',
    '[class*="operation"]',
    '[class*="button"]',
    '[class*="btn"]',
    ".time",
    ".time-location",
    ".view-more",
    "#view-more",
    "bili-text-button",
    ".paging-box",
    ".pagination",
  ].join(",");

  const EMOJI_SELECTOR = [
    'img[class*="emoji"]',
    'img[class*="emote"]',
    'img[src*="emote"]',
    'img[src*="emoji"]',
    'span[class*="emoji"]',
    'span[class*="emote"]',
    'i[class*="emoji"]',
    'svg[class*="emoji"]',
    'bili-rich-text-module[class*="emoji"]',
  ].join(",");

  const MESSAGE_AREA_SELECTOR = [
    ".message-list",
    ".message-list-content",
    ".message-item",
    ".interaction-item__content",
    ".interaction-item__msg",
    ".interaction-item__reference",
    ".interaction-item__cover",
    ".at-item",
    ".msg-list",
    ".msg-item",
    ".talk-item",
    ".chat-content",
    ".chat-history",
    ".im-container",
    '[class*="_ChatWindow_"]',
    '[class*="_ChatContent_"]',
    '[class*="_MessageList_"]',
    '[class*="_SessionList_"]',
    "#message-list",
  ].join(",");

  const MESSAGE_ITEM_SELECTOR = [
    ".message-list .message-item",
    ".message-list .reply-item",
    ".message-list .at-item",
    ".message-list .list-item",
    '.message-list [class*="item"]',
    '.message-list [class*="card"]',
    ".interaction-item__content",
    ".message-item",
    ".at-item",
    '.im-container [class*="_SessionItem_"]',
    '.im-container [class*="_Msg_"]',
    ".msg-list .msg-item",
    ".msg-item",
    ".talk-item",
    ".chat-content",
    ".chat-history",
  ].join(",");

  const MESSAGE_BODY_SELECTOR = [
    ".message-list .content",
    ".message-list .text",
    ".message-list .desc",
    ".message-item .content",
    ".message-item .text",
    ".message-item .desc",
    ".at-item .content",
    ".at-item .text",
    ".at-item .desc",
    ".msg-item .content",
    ".msg-item .text",
    ".msg-item .desc",
    ".talk-item .content",
    ".talk-item .text",
    ".talk-item .desc",
    ".chat-content .bubble",
    ".chat-content .text",
    ".chat-history .bubble",
    ".chat-history .text",
    ".message-list .source-content",
    ".message-list .notify-content",
    ".interaction-item__msg",
    ".interaction-item__reference",
    ".interaction-item__cover",
    '.im-container [class*="_SessionItem__Message_"]',
    '.im-container [class*="_MsgText__Content_"]',
    '.im-container [class*="_RichText_"]',
  ].join(",");

  const MESSAGE_TITLE_ACTION_RE =
    /(回复了我的评论|在评论中@了我|对我的视频发表了评论|赞了我的视频|赞了我的评论|赞了我的动态|赞了我的专栏|赞了我的投稿|@了我|回复了我|评论了我|提到了我)/;

  const originalMap = new WeakMap();
  const hoverTimerMap = new WeakMap();
  const observedRoots = new WeakSet();
  const styledRoots = new WeakSet();
  const knownRoots = new Set();
  const pendingRoots = new Set();

  let rafId = 0;
  let controlPanel = null;
  let toggleButton = null;
  let settingsButton = null;
  let settingsMenu = null;
  let languageMenuExpanded = false;
  let petMenuExpanded = false;
  let avatarCoverSeq = 0;
  const mediaPassThroughEvents = new WeakSet();

  injectStyle();
  initWhenReady();
  observeRoot(document);
  syncAllCommentEditorPlaceholders();
  enqueue(document);

  window.setInterval(() => {
    scanShadowRoots(document);
    syncSharedStateFromCookie();
    syncAllCommentEditorPlaceholders();
    if (enabled) enqueue(document);
  }, 1200);

  window.setInterval(syncSharedStateFromCookie, 500);

  window.addEventListener("storage", (event) => {
    if (event.key === CFG.enabledKey) {
      applySharedEnabled(event.newValue);
    } else if (event.key === CFG.languageKey) {
      applySharedLanguage(event.newValue || CFG.defaultLanguage);
    } else if (event.key === CFG.petKey) {
      applySharedPet(event.newValue || CFG.defaultPet);
    } else if (event.key === CFG.sendInterceptKey) {
      applySharedSendIntercept(event.newValue);
    }
  });

  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener(CFG.enabledKey, (_name, _oldValue, newValue) => {
      applySharedEnabled(newValue);
    });
    GM_addValueChangeListener(CFG.languageKey, (_name, _oldValue, newValue) => {
      applySharedLanguage(newValue || CFG.defaultLanguage);
    });
    GM_addValueChangeListener(CFG.petKey, (_name, _oldValue, newValue) => {
      applySharedPet(newValue || CFG.defaultPet);
    });
    GM_addValueChangeListener(
      CFG.sendInterceptKey,
      (_name, _oldValue, newValue) => {
        applySharedSendIntercept(newValue);
      },
    );
  }

  window.addEventListener("focus", syncSharedStateFromCookie);
  window.addEventListener("pageshow", syncSharedStateFromCookie);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncSharedStateFromCookie();
  });

  function initWhenReady() {
    const run = () => {
      createToggleButton();
      updatePageStateClass();
      runImmediateSweep();
    };

    if (document.body) run();
    else document.addEventListener("DOMContentLoaded", run, { once: true });
  }

  function injectStyle(root = document) {
    if (!root || styledRoots.has(root)) return;

    const css = `
      html.bcp-enabled .bcp-masked-avatar {
        border-radius: 50% !important;
        object-fit: cover !important;
        background: #e5e7eb !important;
      }

      .bcp-masked-avatar {
        border-radius: 50% !important;
        object-fit: cover !important;
        background: #e5e7eb !important;
      }

      html.bcp-enabled .bcp-avatar-box-mask,
      .bcp-avatar-box-mask {
        position: relative !important;
      }

      html.bcp-enabled .bcp-avatar-box-mask img,
      html.bcp-enabled .bcp-avatar-box-mask picture,
      html.bcp-enabled .bcp-avatar-box-mask canvas,
      html.bcp-enabled .bcp-avatar-box-mask bili-avatar,
      html.bcp-enabled .bcp-avatar-box-mask [class*="avatar"],
      html.bcp-enabled .bcp-avatar-box-mask [class*="face"] {
        opacity: 0 !important;
        visibility: hidden !important;
      }

      .bcp-avatar-box-mask img,
      .bcp-avatar-box-mask picture,
      .bcp-avatar-box-mask canvas,
      .bcp-avatar-box-mask bili-avatar,
      .bcp-avatar-box-mask [class*="avatar"],
      .bcp-avatar-box-mask [class*="face"] {
        opacity: 0 !important;
        visibility: hidden !important;
      }

      html.bcp-enabled [data-bcp-avatar-cover],
      [data-bcp-avatar-cover] {
        display: block !important;
        opacity: 1 !important;
        visibility: visible !important;
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        z-index: 1 !important;
        pointer-events: auto !important;
        border-radius: 50% !important;
        background-color: #e5e7eb !important;
        background-image: url("${MASK_AVATAR}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-repeat: no-repeat !important;
      }

      [data-bcp-kind="comment"] {
        cursor: pointer !important;
        word-break: break-word !important;
      }

      [data-bcp-kind="comment"][data-bcp-state="masked"] {
        user-select: none !important;
      }

      [data-bcp-kind="comment"][data-bcp-media="image"] {
        box-sizing: border-box !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: auto !important;
        padding: 0 !important;
        border-radius: 6px !important;
        border: 1px solid rgba(0, 174, 236, .26) !important;
        background: rgba(0, 174, 236, .1) !important;
        color: #00aeec !important;
        font-size: 14px !important;
        line-height: 1.35 !important;
        text-align: center !important;
        white-space: normal !important;
        vertical-align: middle !important;
        overflow: hidden !important;
      }

      [data-bcp-kind="comment"][data-bcp-media="image"] [data-bcp-media-cover] {
        box-sizing: border-box !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        position: absolute !important;
        inset: 0 !important;
        z-index: 1 !important;
        width: 100% !important;
        height: 100% !important;
        padding: 8px !important;
        border-radius: inherit !important;
        border: 1px solid rgba(0, 174, 236, .28) !important;
        background: #e5f6fd !important;
        color: #00aeec !important;
        font-size: inherit !important;
        line-height: inherit !important;
        text-align: center !important;
        white-space: normal !important;
        cursor: pointer !important;
        pointer-events: auto !important;
      }

      [data-bcp-kind="comment"][data-bcp-media="image"][data-bcp-state="preview"] img,
      [data-bcp-kind="comment"][data-bcp-media="image"][data-bcp-state="preview"] picture,
      [data-bcp-kind="comment"][data-bcp-media="image"][data-bcp-state="preview"] video,
      [data-bcp-kind="comment"][data-bcp-media="image"][data-bcp-state="preview"] canvas {
        max-width: 100% !important;
        max-height: 100% !important;
        object-fit: contain !important;
        position: relative !important;
        z-index: auto !important;
        visibility: visible !important;
        opacity: 1 !important;
      }

      [data-bcp-kind="comment"][data-bcp-media="image"][data-bcp-media-mode="compact"] {
        font-size: 12px !important;
        line-height: 1.25 !important;
      }

      #bcp-control-panel {
        position: fixed;
        left: 12px;
        top: 76px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #bcp-toggle {
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        background: #00aeec;
        color: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,.18);
      }

      #bcp-toggle.bcp-off {
        background: #999;
        color: #fff;
      }

      #bcp-settings-button {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        background: rgba(255,255,255,.96);
        color: #6b7280;
        font-size: 16px;
        line-height: 1;
        box-shadow: 0 4px 16px rgba(0,0,0,.16);
      }

      #bcp-settings-button:hover {
        color: #00aeec;
      }

      #bcp-settings-menu {
        position: absolute;
        left: 0;
        top: calc(100% + 8px);
        min-width: 148px;
        border: 1px solid rgba(0,0,0,.08);
        border-radius: 8px;
        padding: 6px;
        background: #fff;
        color: #18191c;
        box-shadow: 0 8px 24px rgba(0,0,0,.16);
        font-size: 13px;
      }

      #bcp-settings-menu[hidden] {
        display: none !important;
      }

      .bcp-settings-title {
        padding: 6px 8px;
        color: #61666d;
        line-height: 1.2;
      }

      .bcp-language-option {
        width: 100%;
        border: 0;
        border-radius: 6px;
        padding: 7px 8px;
        background: transparent;
        color: #18191c;
        cursor: pointer;
        text-align: left;
        font-size: 13px;
        line-height: 1.2;
      }

      .bcp-language-option:hover,
      .bcp-language-option.bcp-selected {
        background: rgba(0,174,236,.12);
        color: #00aeec;
      }

      .bcp-menu-row {
        font-weight: 600;
      }

      .bcp-option-group {
        margin: 2px 0 4px;
        padding-left: 8px;
      }

      .bcp-option-group[hidden] {
        display: none !important;
      }
    `;

    const style = document.createElement("style");
    style.dataset.bcpStyle = "1";
    style.textContent = css;

    const append = () => {
      const target =
        root === document ? document.head || document.documentElement : root;
      if (!target) return;
      target.appendChild(style);
      styledRoots.add(root);
    };

    if (root === document && !(document.head || document.documentElement)) {
      document.addEventListener("DOMContentLoaded", append, { once: true });
    } else {
      append();
    }
  }

  function createToggleButton() {
    if (toggleButton || !document.body) return;

    controlPanel = document.createElement("div");
    controlPanel.id = "bcp-control-panel";

    toggleButton = document.createElement("button");
    toggleButton.id = "bcp-toggle";
    toggleButton.type = "button";
    toggleButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setEnabled(!enabled);
      },
      true,
    );

    settingsButton = document.createElement("button");
    settingsButton.id = "bcp-settings-button";
    settingsButton.type = "button";
    settingsButton.textContent = "⚙";
    settingsButton.setAttribute("aria-label", "设置");
    settingsButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        toggleSettingsMenu();
      },
      true,
    );

    settingsMenu = document.createElement("div");
    settingsMenu.id = "bcp-settings-menu";
    settingsMenu.hidden = true;
    settingsMenu.innerHTML = `
      <button type="button" class="bcp-language-option bcp-menu-row" data-bcp-toggle-language></button>
      <div class="bcp-option-group" data-bcp-language-options hidden>
        <button type="button" class="bcp-language-option" data-bcp-language="zh">中文</button>
        <button type="button" class="bcp-language-option" data-bcp-language="ko">한국어</button>
        <button type="button" class="bcp-language-option" data-bcp-language="en">English</button>
        <button type="button" class="bcp-language-option" data-bcp-language="ja">日本語</button>
      </div>
      <button type="button" class="bcp-language-option bcp-menu-row" data-bcp-toggle-pet></button>
      <div class="bcp-option-group" data-bcp-pet-options hidden>
        <button type="button" class="bcp-language-option" data-bcp-pet="cat">猫</button>
        <button type="button" class="bcp-language-option" data-bcp-pet="dog">狗</button>
        <button type="button" class="bcp-language-option" data-bcp-pet="frog">青蛙</button>
        <button type="button" class="bcp-language-option" data-bcp-pet="cow">牛</button>
        <button type="button" class="bcp-language-option" data-bcp-pet="sheep">羊</button>
      </div>
      <button type="button" class="bcp-language-option" data-bcp-send-intercept></button>
    `;
    settingsMenu.addEventListener(
      "click",
      (event) => {
        const languageToggle = event.target?.closest?.(
          "[data-bcp-toggle-language]",
        );
        if (languageToggle) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          languageMenuExpanded = !languageMenuExpanded;
          petMenuExpanded = false;
          updateLanguageMenu();
          return;
        }

        const sendInterceptOption = event.target?.closest?.(
          "[data-bcp-send-intercept]",
        );
        if (sendInterceptOption) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          setSendIntercept(!sendInterceptEnabled);
          return;
        }

        const petToggle = event.target?.closest?.("[data-bcp-toggle-pet]");
        if (petToggle) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          petMenuExpanded = !petMenuExpanded;
          languageMenuExpanded = false;
          updateLanguageMenu();
          return;
        }

        const option = event.target?.closest?.("[data-bcp-language]");
        if (option) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          setLanguage(option.dataset.bcpLanguage);
          languageMenuExpanded = false;
          updateLanguageMenu();
          return;
        }

        const petOption = event.target?.closest?.("[data-bcp-pet]");
        if (!petOption) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        setPet(petOption.dataset.bcpPet);
        petMenuExpanded = false;
        updateLanguageMenu();
      },
      true,
    );

    controlPanel.append(toggleButton, settingsButton, settingsMenu);
    document.body.appendChild(controlPanel);
    document.addEventListener("click", closeSettingsMenu, true);
    updateToggleButton();
    updateLanguageMenu();
  }

  function setEnabled(next, options = {}) {
    enabled = Boolean(next);
    if (!options.fromStorage)
      writeSharedState(CFG.enabledCookie, CFG.enabledKey, enabled ? "1" : "0");

    updatePageStateClass();
    updateToggleButton();

    if (enabled) {
      runImmediateSweep();
      scheduleFollowUpSweeps();
    } else {
      restoreAll();
    }
  }

  function updatePageStateClass() {
    document.documentElement.classList.toggle("bcp-enabled", enabled);
  }

  function updateToggleButton() {
    if (!toggleButton) return;
    const pack = I18N[language] || I18N[CFG.defaultLanguage];
    toggleButton.textContent = enabled ? pack.on : pack.off;
    toggleButton.classList.toggle("bcp-off", !enabled);
  }

  function toggleSettingsMenu() {
    if (!settingsMenu) return;
    settingsMenu.hidden = !settingsMenu.hidden;
    updateLanguageMenu();
  }

  function closeSettingsMenu(event) {
    if (!settingsMenu || settingsMenu.hidden) return;
    if (event?.target && controlPanel?.contains?.(event.target)) return;
    settingsMenu.hidden = true;
  }

  function setLanguage(next, options = {}) {
    const previous = language;
    language = ["zh", "ko", "en", "ja"].includes(next)
      ? next
      : CFG.defaultLanguage;
    if (!options.fromStorage)
      writeSharedState(CFG.languageCookie, CFG.languageKey, language);
    syncSendInterceptBridgeState();
    updateToggleButton();
    updateLanguageMenu();

    if (enabled && language !== previous) {
      restoreAll();
      runImmediateSweep();
      scheduleFollowUpSweeps();
    }
  }

  function setPet(next, options = {}) {
    const previous = pet;
    pet = Object.prototype.hasOwnProperty.call(PETS, next)
      ? next
      : CFG.defaultPet;
    if (!options.fromStorage) writeSharedState(CFG.petCookie, CFG.petKey, pet);
    syncSendInterceptBridgeState();
    syncAllCommentEditorPlaceholders();
    updateLanguageMenu();

    if (enabled && pet !== previous) {
      restoreAll();
      runImmediateSweep();
      scheduleFollowUpSweeps();
    }
  }

  function syncSharedStateFromCookie() {
    const gmEnabled = readGMState(CFG.enabledKey);
    if (gmEnabled !== null) applySharedEnabled(gmEnabled);
    const gmLanguage = readGMState(CFG.languageKey);
    if (gmLanguage !== null) applySharedLanguage(gmLanguage);
    const gmPet = readGMState(CFG.petKey);
    if (gmPet !== null) applySharedPet(gmPet);
    const gmSendIntercept = readGMState(CFG.sendInterceptKey);
    if (gmSendIntercept !== null) applySharedSendIntercept(gmSendIntercept);

    const sharedEnabled = readCookie(CFG.enabledCookie);
    if (sharedEnabled !== null && gmEnabled === null)
      applySharedEnabled(sharedEnabled);

    const sharedLanguage = readCookie(CFG.languageCookie);
    if (sharedLanguage !== null && gmLanguage === null)
      applySharedLanguage(sharedLanguage);

    const sharedPet = readCookie(CFG.petCookie);
    if (sharedPet !== null && gmPet === null) applySharedPet(sharedPet);

    const sharedSendIntercept = readCookie(CFG.sendInterceptCookie);
    if (sharedSendIntercept !== null && gmSendIntercept === null)
      applySharedSendIntercept(sharedSendIntercept);
  }

  function applySharedEnabled(value) {
    if (value === null || value === undefined) return;
    const normalized = value === "1" || value === true ? "1" : "0";
    writeLocalState(CFG.enabledKey, normalized);
    if ((normalized === "1") !== enabled) {
      setEnabled(normalized === "1", { fromStorage: true });
    }
  }

  function applySharedLanguage(value) {
    if (value === null || value === undefined) return;
    const normalized = ["zh", "ko", "en", "ja"].includes(value)
      ? value
      : CFG.defaultLanguage;
    writeLocalState(CFG.languageKey, normalized);
    if (normalized !== language) {
      setLanguage(normalized, { fromStorage: true });
    }
  }

  function applySharedPet(value) {
    if (value === null || value === undefined) return;
    const normalized = Object.prototype.hasOwnProperty.call(PETS, value)
      ? value
      : CFG.defaultPet;
    writeLocalState(CFG.petKey, normalized);
    if (normalized !== pet) {
      setPet(normalized, { fromStorage: true });
    }
  }

  function setSendIntercept(next, options = {}) {
    sendInterceptEnabled = Boolean(next);
    if (!options.fromStorage) {
      writeSharedState(
        CFG.sendInterceptCookie,
        CFG.sendInterceptKey,
        sendInterceptEnabled ? "1" : "0",
      );
    }
    syncSendInterceptBridgeState();
    syncAllCommentEditorPlaceholders();
    updateLanguageMenu();
  }

  function applySharedSendIntercept(value) {
    if (value === null || value === undefined) return;
    const normalized = value === "1" || value === true ? "1" : "0";
    writeLocalState(CFG.sendInterceptKey, normalized);
    if ((normalized === "1") !== sendInterceptEnabled) {
      setSendIntercept(normalized === "1", { fromStorage: true });
    }
  }

  function updateLanguageMenu() {
    if (!settingsMenu) return;
    const languageToggle = settingsMenu.querySelector(
      "[data-bcp-toggle-language]",
    );
    if (languageToggle) {
      languageToggle.textContent = `切换语言：${getLanguageName()}`;
    }
    const languageOptions = settingsMenu.querySelector(
      "[data-bcp-language-options]",
    );
    if (languageOptions) languageOptions.hidden = !languageMenuExpanded;
    for (const option of settingsMenu.querySelectorAll("[data-bcp-language]")) {
      option.classList.toggle(
        "bcp-selected",
        option.dataset.bcpLanguage === language,
      );
    }
    const sendOption = settingsMenu.querySelector("[data-bcp-send-intercept]");
    if (sendOption) {
      sendOption.textContent = getSendInterceptLabel();
      sendOption.classList.toggle("bcp-selected", sendInterceptEnabled);
    }
    const petToggle = settingsMenu.querySelector("[data-bcp-toggle-pet]");
    if (petToggle) {
      petToggle.textContent = `选择宠物：${getPetName()}`;
    }
    const petOptions = settingsMenu.querySelector("[data-bcp-pet-options]");
    if (petOptions) petOptions.hidden = !petMenuExpanded;
    for (const option of settingsMenu.querySelectorAll("[data-bcp-pet]")) {
      option.classList.toggle("bcp-selected", option.dataset.bcpPet === pet);
    }
  }

  function readSharedState(cookieName, storageKey, legacyCookieName) {
    const gmValue = readGMState(storageKey);
    if (gmValue !== null) {
      writeLocalState(storageKey, gmValue);
      return gmValue;
    }

    const cookieValue = readCookie(cookieName);
    if (cookieValue !== null) {
      writeLocalState(storageKey, cookieValue);
      return cookieValue;
    }

    if (legacyCookieName) {
      const legacyCookieValue = readCookie(legacyCookieName);
      if (legacyCookieValue !== null) {
        writeLocalState(storageKey, legacyCookieValue);
        return legacyCookieValue;
      }
    }

    try {
      return localStorage.getItem(storageKey);
    } catch (_) {
      return null;
    }
  }

  function writeSharedState(cookieName, storageKey, value) {
    writeLocalState(storageKey, value);
    writeGMState(storageKey, value);
    writeCookie(cookieName, value);
  }

  function initializeSharedState(cookieName, storageKey, value) {
    if (readGMState(storageKey) !== null || readCookie(cookieName) !== null)
      return;
    writeSharedState(cookieName, storageKey, value);
  }

  function readGMState(storageKey) {
    if (!hasGMStorage) return null;
    try {
      const value = GM_getValue(storageKey, null);
      return value === undefined ? null : value;
    } catch (_) {
      return null;
    }
  }

  function writeGMState(storageKey, value) {
    if (!hasGMStorage) return;
    try {
      GM_setValue(storageKey, value);
    } catch (_) {}
  }

  function writeLocalState(storageKey, value) {
    try {
      localStorage.setItem(storageKey, value);
    } catch (_) {}
  }

  function readCookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    const parts = String(document.cookie || "").split(";");

    for (const part of parts) {
      const item = part.trim();
      if (item.startsWith(prefix))
        return decodeURIComponent(item.slice(prefix.length));
    }

    return null;
  }

  function writeCookie(name, value) {
    const expires = new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toUTCString();
    const encoded = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    expireHostCookie(name);
    document.cookie = `${encoded}; expires=${expires}; path=/; domain=.bilibili.com; SameSite=Lax`;
  }

  function expireHostCookie(name) {
    document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  }

  function scheduleFollowUpSweeps() {
    [50, 250, 800, 1600].forEach((delay) => {
      window.setTimeout(() => {
        if (enabled) runImmediateSweep();
      }, delay);
    });
  }

  function runImmediateSweep() {
    if (!enabled) return;
    scanShadowRoots(document);
    for (const root of new Set([document, ...knownRoots])) {
      processRoot(root);
    }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;

    injectStyle(root);

    observedRoots.add(root);
    knownRoots.add(root);
    bindEvents(root);

    const observer = new MutationObserver((records) => {
      scanShadowRoots(root);
      syncAllCommentEditorPlaceholders();
      if (!enabled) return;

      for (const record of records) {
        if (record.type === "attributes") {
          enqueue(record.target);
          continue;
        }

        if (record.type === "characterData") {
          enqueue(record.target.parentElement || root);
          continue;
        }

        for (const node of record.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE ||
            node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ) {
            enqueue(node);
          }
        }
      }
    });

    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "data-src", "srcset", "style", "class"],
    });
  }

  function bindEvents(root) {
    if (!root || !root.addEventListener) return;

    root.addEventListener("click", onClick, true);

    root.addEventListener("pointerover", onHoverStart, true);
    root.addEventListener("mouseover", onHoverStart, true);
    root.addEventListener("mouseenter", onHoverStart, true);

    root.addEventListener("pointerout", onHoverEnd, true);
    root.addEventListener("mouseout", onHoverEnd, true);
    root.addEventListener("mouseleave", onHoverEnd, true);
  }

  function enqueue(root) {
    if (!enabled) return;
    if (
      !root ||
      (!root.querySelectorAll && root.nodeType !== Node.ELEMENT_NODE)
    )
      return;

    pendingRoots.add(root);

    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const roots = [...pendingRoots];
      pendingRoots.clear();

      for (const item of roots) {
        processRoot(item);
      }
    });
  }

  function processRoot(root) {
    if (!enabled || !root) return;

    scanShadowRoots(root);
    processAvatars(root);

    if (isMessagePage()) {
      processNames(root);
      processMessageNoticeHeadings(root);
      processInteractionItems(root);
      processMessageBodies(root);
      return;
    }

    processNames(root);
    protectMessageMedia(root);
    processRichTextFallback(root);
    processCommentBlocks(root);
    processLooseCommentPieces(root);
    processRichTextFallback(root);
  }

  function processAvatars(root) {
    const avatarImgs = querySelfAndDesc(root, AVATAR_IMG_SELECTOR);
    if (root.host?.localName === "bili-avatar" && root.querySelectorAll) {
      avatarImgs.push(...root.querySelectorAll("img"));
    }

    const boxes = querySelfAndDesc(root, AVATAR_BOX_SELECTOR)
      .filter((box) => box.isConnected && isAvatarBoxLike(box))
      .sort((a, b) => depth(b) - depth(a));

    for (const box of boxes) {
      protectAvatarBox(box);
    }

    for (const img of avatarImgs) {
      if (!img.isConnected) continue;
      if (closestComposed(img, ".bcp-avatar-box-mask")) continue;
      protectAvatarImg(img);
    }
  }

  function processNames(root) {
    const candidates = querySelfAndDesc(root, NAME_SELECTOR)
      .filter((el) => el.isConnected && isNameLike(el))
      .sort((a, b) => depth(b) - depth(a));

    for (const el of candidates) {
      if (!el.isConnected) continue;
      if (closestComposed(el.parentElement, '[data-bcp-kind="name"]')) continue;
      if (el.querySelector?.('[data-bcp-kind="name"]')) continue;
      protectName(el);
    }
  }

  function processCommentBlocks(root) {
    const candidates = querySelfAndDesc(root, CONTENT_SELECTOR)
      .filter((el) => el.isConnected && isContentBlockLike(el))
      .sort((a, b) => depth(b) - depth(a));

    for (const el of candidates) {
      if (!el.isConnected) continue;
      if (closestComposed(el.parentElement, '[data-bcp-kind="comment"]'))
        continue;
      if (el.matches?.("bili-rich-text,#content")) {
        protectLooseEmojis(el);
        protectLooseTextNodes(el);
        continue;
      }
      if (containsBiliStickerEmoji(el)) {
        protectLooseEmojis(el);
        protectLooseTextNodes(el);
        continue;
      }
      if (el.querySelector?.('[data-bcp-kind="comment"]')) {
        protectLooseEmojis(el);
        protectLooseTextNodes(el);
        continue;
      }
      protectCommentBlock(el);
    }
  }

  function processRichTextFallback(root) {
    const areas = [];

    if (
      root.host?.matches?.("bili-rich-text,#content") &&
      inCommentArea(root.host)
    ) {
      areas.push(root);
    }

    areas.push(
      ...querySelfAndDesc(root, "bili-rich-text,#content").filter(
        (el) =>
          el.isConnected &&
          inCommentArea(el) &&
          !closestComposed(el, EXCLUDE_SELECTOR),
      ),
    );

    for (const area of [...new Set(areas)]) {
      protectLooseEmojis(area);
      protectLooseTextNodes(area);
    }
  }

  function processLooseCommentPieces(root) {
    const areas = getScanAreas(root);

    for (const area of areas) {
      protectMessageMedia(area);
      protectLooseEmojis(area);
      protectLooseTextNodes(area);
    }
  }

  function processMessageNoticeHeadings(root) {
    for (const item of querySelfAndDesc(root, MESSAGE_ITEM_SELECTOR)) {
      if (!item.isConnected || !inMessageArea(item)) continue;

      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (closestComposed(parent, "[data-bcp-kind]"))
            return NodeFilter.FILTER_REJECT;
          if (closestComposed(parent, EXCLUDE_SELECTOR))
            return NodeFilter.FILTER_REJECT;
          if (!MESSAGE_TITLE_ACTION_RE.test(node.nodeValue || ""))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);

      for (const node of nodes) {
        protectMessageTitlePrefix(node);
        protectMessagePreviousName(node, item);
      }
    }
  }

  function processMessageBodies(root) {
    const areas = [
      ...querySelfAndDesc(root, MESSAGE_BODY_SELECTOR),
      ...querySelfAndDesc(root, MESSAGE_ITEM_SELECTOR),
    ].filter((area) => area.isConnected && inMessageArea(area));

    for (const area of [...new Set(areas)]) {
      protectLooseEmojis(area);
      if (!isDirectMessageChatArea(area)) protectMessageMedia(area);
      protectMessageTextNodes(area);
    }
  }

  function processInteractionItems(root) {
    for (const name of querySelfAndDesc(root, ".interaction-item__uname")) {
      if (!name.isConnected) continue;
      if (!inMessageArea(name)) continue;
      if (closestComposed(name, "[data-bcp-kind]")) continue;
      protectName(name);
    }

    for (const el of querySelfAndDesc(root, ".interaction-item__msg")) {
      if (!el.isConnected) continue;
      if (!inMessageArea(el)) continue;
      if (closestComposed(el, "[data-bcp-kind]")) continue;
      if (isExcludedElementSelf(el)) continue;

      protectInteractionMessageInline(el);
    }

    for (const el of querySelfAndDesc(
      root,
      ".interaction-item__reference,.interaction-item__cover",
    )) {
      if (!el.isConnected) continue;
      if (!inMessageArea(el)) continue;
      if (closestComposed(el, "[data-bcp-kind]")) continue;
      if (isExcludedElementSelf(el)) continue;

      if (containsBiliStickerEmoji(el)) {
        protectMessageTextNodes(el);
        continue;
      }

      if (el.querySelector?.("img,picture,video,canvas")) {
        protectMessageElementAsMedia(el);
      } else {
        protectMessageElementAsComment(el);
      }
    }
  }

  function protectInteractionMessageInline(el) {
    for (const link of querySelfAndDesc(el, 'a[href*="space.bilibili.com"]')) {
      if (!link.isConnected) continue;
      if (closestComposed(link, "[data-bcp-kind]")) continue;
      protectName(link);
    }

    protectMessageTextNodes(el);
  }

  function isExcludedElementSelf(el) {
    return Boolean(
      el?.matches?.(
        [
          "script",
          "style",
          "textarea",
          "input",
          "button",
          '[contenteditable="true"]',
          ".interaction-item__action",
          ".interaction-item__metadata",
          ".interaction-item__btn",
          ".operation",
          ".comment-actions",
          ".toolbar",
          ".action",
          ".like",
          ".hate",
          ".reply-btn",
          ".time",
          ".time-location",
        ].join(","),
      ),
    );
  }

  function protectMessageElementAsComment(el) {
    const count = countVisibleUnits(el);
    if (count <= 0) return;
    const maskLimit = getCommentMaskLimit(el);

    const info = {
      kind: "comment-block",
      html: el.innerHTML,
      count,
      maskLimit,
      masked: buildMiao(count, maskLimit),
    };

    originalMap.set(el, info);
    renderMaskedComment(el, info);
  }

  function protectMessageElementAsMedia(el) {
    const mediaSize = readMediaPlaceholderSize(el, getMediaPlaceholderMode(el));
    const info = {
      kind: "comment-block",
      html: el.innerHTML,
      count: 1,
      masked: getImageMaskText(),
      media: "image",
      mediaSize,
      mediaToggleMode: isInteractionNoticeMedia(el) ? "simple" : "native",
    };

    originalMap.set(el, info);
    renderMaskedComment(el, info);
    el.dataset.bcpMedia = "image";
  }

  function protectMessageMedia(area) {
    if (isDirectMessageChatArea(area)) return;

    const media = querySelfAndDesc(area, "picture,video,canvas,img")
      .filter((el) => el.isConnected)
      .filter((el) => inCommentArea(el))
      .filter((el) => !closestComposed(el, "[data-bcp-kind]"))
      .filter((el) => !closestComposed(el, AVATAR_BOX_SELECTOR))
      .filter((el) => !isAvatarImgLike(el))
      .filter((el) => !el.matches?.(EMOJI_SELECTOR))
      .filter((el) => !isBiliStickerEmoji(el))
      .filter((el) => !isBiliInlineActionIcon(el))
      .filter((el) => !isInsideNativeMediaViewer(el))
      .filter((el) => isProtectablePostedMedia(el))
      .filter((el) => !closestComposed(el, EXCLUDE_SELECTOR))
      .sort((a, b) => depth(a) - depth(b));

    for (const el of media) {
      if (!el.isConnected) continue;
      if (closestComposed(el, "[data-bcp-kind]")) continue;

      const mediaHost = getMediaProtectionHost(el);
      if (mediaHost && mediaHost !== el) {
        protectMessageElementAsMedia(mediaHost);
        continue;
      }

      const span = document.createElement("span");
      const mediaSize = readMediaPlaceholderSize(
        el,
        getMediaPlaceholderMode(el),
      );
      const info = {
        kind: "comment-piece",
        html: el.outerHTML,
        node: el,
        count: 1,
        masked: getImageMaskText(),
        media: "image",
        mediaSize,
        mediaToggleMode: isInteractionNoticeMedia(el) ? "simple" : "native",
      };

      originalMap.set(span, info);
      el.replaceWith(span);
      span.appendChild(el);
      renderMaskedComment(span, info);
    }
  }

  function protectMessageTitlePrefix(node) {
    const raw = node.nodeValue || "";
    const match = raw.match(MESSAGE_TITLE_ACTION_RE);
    if (!match || match.index <= 0) return;

    const prefix = raw.slice(0, match.index);
    if (!normalizeText(prefix)) return;

    const rest = raw.slice(match.index);
    const span = document.createElement("span");
    const info = {
      kind: "name",
      html: escapeHtml(prefix),
      masked: maskName(prefix),
    };

    originalMap.set(span, info);
    renderMaskedName(span, info);
    node.replaceWith(span, document.createTextNode(rest));
  }

  function protectMessagePreviousName(actionNode, item) {
    if (!actionNode?.parentElement || !item) return;

    const raw = actionNode.nodeValue || "";
    if (!MESSAGE_TITLE_ACTION_RE.test(raw)) return;

    const textNodes = collectTextNodes(item);
    const index = textNodes.indexOf(actionNode);
    if (index < 0) return;

    for (let i = index - 1; i >= 0; i -= 1) {
      const node = textNodes[i];
      const parent = node.parentElement;
      const text = normalizeText(node.nodeValue || "");

      if (!parent || !text) continue;
      if (closestComposed(parent, "[data-bcp-kind]")) continue;
      if (closestComposed(parent, EXCLUDE_SELECTOR)) continue;
      if (isMetaText(text)) continue;
      if (MESSAGE_TITLE_ACTION_RE.test(text)) continue;
      if (text.length > 40) continue;

      protectTextNodeAsName(node);
      break;
    }
  }

  function protectTextNodeAsName(node) {
    if (!node?.parentElement) return;

    const text = node.nodeValue || "";
    if (!normalizeText(text)) return;

    const span = document.createElement("span");
    const info = {
      kind: "name",
      html: escapeHtml(text),
      masked: maskName(text),
    };

    originalMap.set(span, info);
    renderMaskedName(span, info);
    node.replaceWith(span);
  }

  function protectMessageTextNodes(area) {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !normalizeText(node.nodeValue))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, "[data-bcp-kind]"))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, EXCLUDE_SELECTOR))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, NAME_SELECTOR))
          return NodeFilter.FILTER_REJECT;
        if (isMessageMentionLike(parent)) return NodeFilter.FILTER_REJECT;
        if (!inMessageArea(parent)) return NodeFilter.FILTER_REJECT;

        const text = normalizeText(node.nodeValue);
        if (MESSAGE_TITLE_ACTION_RE.test(text)) return NodeFilter.FILTER_REJECT;
        if (isMetaText(text) || isReplyExpandSeparatorNode(node))
          return NodeFilter.FILTER_REJECT;
        if (isLikelyMessageTitleNameNode(node, area))
          return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (!node.parentElement) continue;

      const count = countTextUnits(node.nodeValue || "");
      if (count <= 0) continue;

      const span = document.createElement("span");
      const info = {
        kind: "comment-piece",
        html: escapeHtml(node.nodeValue || ""),
        count,
        masked: buildMiao(count),
      };

      originalMap.set(span, info);
      span.textContent = info.masked;
      markProtected(span, "comment", "masked");

      node.replaceWith(span);
    }
  }

  function isLikelyMessageTitleNameNode(node, area) {
    const text = normalizeText(node.nodeValue || "");
    if (!text || text.length > 40) return false;

    const textNodes = collectTextNodes(area);
    const index = textNodes.indexOf(node);
    if (index < 0) return false;

    for (let i = index + 1; i < Math.min(textNodes.length, index + 4); i += 1) {
      if (MESSAGE_TITLE_ACTION_RE.test(textNodes[i].nodeValue || ""))
        return true;
    }

    return false;
  }

  function protectAvatarImg(img) {
    if (!enabled) return;
    if (!inCommentArea(img) || !isAvatarImgLike(img)) return;

    const info = originalMap.get(img);

    if (info?.kind === "avatar-img") {
      if (!isMaskedAvatarImg(img)) info.attrs = readImgAttrs(img);
      renderMaskedAvatarImg(img, info);
      return;
    }

    if (isMaskedAvatarImg(img)) return;

    const attrs = readImgAttrs(img);
    if (!attrs.src && !attrs.dataSrc && !attrs.srcset) return;

    const newInfo = {
      kind: "avatar-img",
      attrs,
    };

    originalMap.set(img, newInfo);
    renderMaskedAvatarImg(img, newInfo);
  }

  function protectAvatarBox(box) {
    if (!enabled) return;
    const target = getAvatarMaskTarget(box);
    if (target && target !== box) {
      protectAvatarBox(target);
      return;
    }

    if (!inCommentArea(box) || !isAvatarBoxLike(box)) return;

    const info = originalMap.get(box);

    if (info?.kind === "avatar-box") {
      renderMaskedAvatarBox(box, info);
      return;
    }

    const newInfo = {
      kind: "avatar-box",
      inline: {
        position: box.style.position,
        overflow: box.style.overflow,
        background: box.style.background,
        backgroundColor: box.style.backgroundColor,
        backgroundImage: box.style.backgroundImage,
        backgroundSize: box.style.backgroundSize,
        backgroundPosition: box.style.backgroundPosition,
        backgroundRepeat: box.style.backgroundRepeat,
        borderRadius: box.style.borderRadius,
        display: box.style.display,
        lineHeight: box.style.lineHeight,
        width: box.style.width,
        height: box.style.height,
        minWidth: box.style.minWidth,
        minHeight: box.style.minHeight,
      },
    };

    originalMap.set(box, newInfo);
    renderMaskedAvatarBox(box, newInfo);
  }

  function getAvatarMaskTarget(box) {
    if (!box || box.nodeType !== Node.ELEMENT_NODE) return box;
    if (box.localName !== "bili-avatar") return box;

    const parentMask = closestComposed(
      box.parentElement,
      "#user-avatar,a[data-user-profile-id],a[data-user-profile-spmid-follow],.user-face,.reply-face,.face,.avatar,.bili-avatar,.root-reply-avatar,.sub-reply-avatar,.bili-comment-avatar",
    );

    return parentMask || box;
  }

  function protectName(el) {
    if (!enabled) return;

    const info = originalMap.get(el);

    if (info?.kind === "name") {
      if (el.dataset.bcpState !== "masked" || el.textContent !== info.masked) {
        info.html = el.innerHTML;
        info.masked = maskName(el.textContent || "");
      }
      renderMaskedName(el, info);
      return;
    }

    const text = normalizeText(el.textContent || "");
    if (!text) return;

    const newInfo = {
      kind: "name",
      html: el.innerHTML,
      masked: maskName(el.textContent || ""),
    };

    originalMap.set(el, newInfo);
    renderMaskedName(el, newInfo);
  }

  function protectCommentBlock(el) {
    if (!enabled) return;

    const info = originalMap.get(el);

    if (info?.kind === "comment-block") {
      if (el.dataset.bcpState !== "masked") {
        info.html = el.innerHTML;
        info.count = countVisibleUnits(el);
        info.maskLimit = getCommentMaskLimit(el);
        info.masked = buildMiao(info.count, info.maskLimit);
      } else {
        if (
          el.textContent !== info.masked &&
          !isPureMiao(el.textContent || "")
        ) {
          info.html = el.innerHTML;
          info.count = countVisibleUnits(el);
          info.maskLimit = getCommentMaskLimit(el);
          info.masked = buildMiao(info.count, info.maskLimit);
        }
      }
      renderMaskedComment(el, info);
      return;
    }

    const count = countVisibleUnits(el);
    if (count <= 0) return;
    const maskLimit = getCommentMaskLimit(el);

    const newInfo = {
      kind: "comment-block",
      html: el.innerHTML,
      count,
      maskLimit,
      masked: buildMiao(count, maskLimit),
    };

    originalMap.set(el, newInfo);
    renderMaskedComment(el, newInfo);
  }

  function protectLooseTextNodes(area) {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !normalizeText(node.nodeValue))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, "[data-bcp-kind]"))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, EXCLUDE_SELECTOR))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, NAME_SELECTOR))
          return NodeFilter.FILTER_REJECT;
        if (!inCommentArea(parent)) return NodeFilter.FILTER_REJECT;
        if (
          !closestComposed(parent, COMMENT_ITEM_SELECTOR) &&
          !closestComposed(parent, CONTENT_SELECTOR)
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = normalizeText(node.nodeValue);
        if (isMetaText(text) || isReplyExpandSeparatorNode(node))
          return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (!node.parentElement) continue;

      const count = countTextUnits(node.nodeValue || "");
      if (count <= 0) continue;

      const span = document.createElement("span");
      const info = {
        kind: "comment-piece",
        html: escapeHtml(node.nodeValue || ""),
        count,
        masked: buildMiao(count),
      };

      originalMap.set(span, info);
      span.textContent = info.masked;
      markProtected(span, "comment", "masked");

      node.replaceWith(span);
    }
  }

  function protectLooseEmojis(area) {
    for (const el of querySelfAndDesc(area, EMOJI_SELECTOR)) {
      if (!el.isConnected) continue;
      if (closestComposed(el, "[data-bcp-kind]")) continue;
      if (closestComposed(el, EXCLUDE_SELECTOR)) continue;
      if (closestComposed(el, NAME_SELECTOR)) continue;
      if (isAvatarImgLike(el)) continue;
      if (isBiliStickerEmoji(el)) continue;
      if (!inCommentArea(el)) continue;
      if (
        !closestComposed(el, COMMENT_ITEM_SELECTOR) &&
        !closestComposed(el, CONTENT_SELECTOR)
      )
        continue;

      const span = document.createElement("span");
      const info = {
        kind: "comment-piece",
        html: el.outerHTML,
        count: 1,
        masked: getCommentMaskText(),
      };

      originalMap.set(span, info);
      span.textContent = info.masked;
      markProtected(span, "comment", "masked");

      el.replaceWith(span);
    }
  }

  function renderMaskedAvatarImg(img, info) {
    if (!info) return;

    img.src = MASK_AVATAR;
    img.setAttribute("src", MASK_AVATAR);
    img.setAttribute("data-src", MASK_AVATAR);
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.classList.add("bcp-masked-avatar");

    markProtected(img, "avatar", "masked");
  }

  function renderOriginalAvatarImg(img, info, state) {
    if (!info) return;

    restoreAttr(img, "src", info.attrs.src);
    restoreAttr(img, "data-src", info.attrs.dataSrc);
    restoreAttr(img, "srcset", info.attrs.srcset);
    restoreAttr(img, "sizes", info.attrs.sizes);
    img.classList.remove("bcp-masked-avatar");

    markProtected(img, "avatar", state);
  }

  function renderMaskedAvatarBox(box, info) {
    if (!info) return;

    box.classList.add("bcp-avatar-box-mask");
    applyMaskedAvatarBoxInline(box, info);
    markProtected(box, "avatar", "masked");
  }

  function renderOriginalAvatarBox(box, info, state) {
    if (!info) return;

    removeAvatarCover(box);
    box.classList.remove("bcp-avatar-box-mask");
    if (info.coverHost)
      info.coverHost.style.position = info.coverHostPosition || "";
    box.style.position = info.inline.position;
    box.style.overflow = info.inline.overflow;
    box.style.background = info.inline.background;
    box.style.backgroundColor = info.inline.backgroundColor || "";
    box.style.backgroundImage = info.inline.backgroundImage;
    box.style.backgroundSize = info.inline.backgroundSize;
    box.style.backgroundPosition = info.inline.backgroundPosition;
    box.style.backgroundRepeat = info.inline.backgroundRepeat;
    box.style.borderRadius = info.inline.borderRadius;
    box.style.display = info.inline.display;
    box.style.lineHeight = info.inline.lineHeight;
    box.style.width = info.inline.width;
    box.style.height = info.inline.height;
    box.style.minWidth = info.inline.minWidth;
    box.style.minHeight = info.inline.minHeight;

    markProtected(box, "avatar", state);
  }

  function applyMaskedAvatarBoxInline(box, info) {
    if (!box) return;

    ensureAvatarCover(box, info);
  }

  function ensureAvatarCover(box, info) {
    const size = readAvatarBoxSize(box);
    const placement = getAvatarCoverPlacement(box, size);
    const host = placement.host || box;
    const coverId =
      box.dataset.bcpAvatarCoverId || `bcp-avatar-${++avatarCoverSeq}`;
    const staleCover = box.querySelector?.(":scope > [data-bcp-avatar-cover]");
    let cover = findAvatarCover(host, coverId);

    box.dataset.bcpAvatarCoverId = coverId;
    if (staleCover && staleCover !== cover) staleCover.remove();
    if (!cover) cover = document.createElement("span");

    if (info && info.coverHost !== host) {
      if (info.coverHost)
        info.coverHost.style.position = info.coverHostPosition || "";
      info.coverHost = host;
      info.coverHostPosition = host.style.position;
    }

    cover.setAttribute("data-bcp-avatar-cover", "1");
    cover.dataset.bcpAvatarCoverFor = coverId;
    cover.setAttribute("aria-hidden", "true");
    cover.style.setProperty("display", "block", "important");
    cover.style.setProperty("width", size.width || "100%", "important");
    cover.style.setProperty(
      "height",
      size.height || size.width || "100%",
      "important",
    );
    cover.style.setProperty("left", placement.left, "important");
    cover.style.setProperty("top", placement.top, "important");

    host.style.setProperty("position", "relative", "important");
    if (cover.parentElement !== host) host.appendChild(cover);
  }

  function removeAvatarCover(box) {
    const coverId = box?.dataset?.bcpAvatarCoverId;
    box?.querySelector?.(":scope > [data-bcp-avatar-cover]")?.remove();

    if (coverId) {
      for (const root of new Set([document, ...knownRoots])) {
        findAvatarCover(root, coverId)?.remove();
      }
      delete box.dataset.bcpAvatarCoverId;
    }
  }

  function findAvatarCover(root, coverId) {
    if (!root || !coverId) return null;
    return (
      Array.from(root.querySelectorAll?.("[data-bcp-avatar-cover]") || []).find(
        (el) => el.dataset.bcpAvatarCoverFor === coverId,
      ) || null
    );
  }

  function getAvatarCoverPlacement(box, size = {}) {
    const itemBody = box.closest?.("#body");
    if (
      itemBody?.querySelector?.("#main") &&
      (box.id === "user-avatar" ||
        box.matches?.(
          "a[data-user-profile-id],a[data-user-profile-spmid-follow]",
        ))
    ) {
      const main = itemBody.querySelector("#main");
      const header = main?.querySelector?.("#header") || main;
      const bodyRect = itemBody.getBoundingClientRect?.();
      const mainRect = main?.getBoundingClientRect?.();
      const headerRect = header?.getBoundingClientRect?.();
      const width = cssPxToNumber(size.width) || 48;
      const height = cssPxToNumber(size.height) || width;

      if (
        bodyRect &&
        mainRect &&
        headerRect &&
        mainRect.width > 0 &&
        headerRect.height > 0
      ) {
        const left = Math.max(
          0,
          Math.round(mainRect.left - bodyRect.left - width - 10),
        );
        const top = Math.max(
          0,
          Math.round(
            headerRect.top - bodyRect.top + (headerRect.height - height) / 2,
          ),
        );

        return { host: itemBody, left: `${left}px`, top: `${top}px` };
      }

      return { host: itemBody, left: "0px", top: "0px" };
    }

    return { host: box, left: "0px", top: "0px" };
  }

  function readAvatarBoxSize(box) {
    const child = box.querySelector?.("bili-avatar") || box;
    const childStyle = child ? getComputedStyle(child) : null;
    const boxRect = box.getBoundingClientRect?.();
    const childRect = child?.getBoundingClientRect?.();

    const width =
      normalizeCssLength(child?.style?.getPropertyValue("--avatar-width")) ||
      normalizeCssLength(childStyle?.getPropertyValue("--avatar-width")) ||
      normalizeCssLength(child?.style?.width) ||
      rectLength(childRect?.width) ||
      rectLength(boxRect?.width);

    const height =
      normalizeCssLength(child?.style?.getPropertyValue("--avatar-height")) ||
      normalizeCssLength(childStyle?.getPropertyValue("--avatar-height")) ||
      normalizeCssLength(child?.style?.height) ||
      rectLength(childRect?.height) ||
      rectLength(boxRect?.height);

    return { width, height };
  }

  function normalizeCssLength(value) {
    const text = String(value || "").trim();
    if (!text || text === "auto") return "";
    if (/^\d+(\.\d+)?px$/.test(text)) return text;
    if (/^\d+(\.\d+)?$/.test(text)) return `${text}px`;
    return "";
  }

  function rectLength(value) {
    return Number.isFinite(value) && value > 0 ? `${Math.round(value)}px` : "";
  }

  function cssPxToNumber(value) {
    const match = String(value || "").match(/^(\d+(?:\.\d+)?)px$/);
    return match ? Number(match[1]) : 0;
  }

  function getMediaPlaceholderMode(el) {
    if (isInteractionNoticeMedia(el)) return "compact";
    return "large";
  }

  function isInteractionNoticeMedia(el) {
    if (!isMessagePage()) return false;
    if (
      closestComposed(
        el,
        ".interaction-item__cover,.interaction-item__reference",
      )
    )
      return true;

    const route =
      `${location.pathname || ""} ${location.hash || ""}`.toLowerCase();
    return /reply|at|love|like|praise|收到的赞|赞/.test(route);
  }

  function getMediaProtectionHost(el) {
    if (!el) return null;
    return closestComposed(
      el,
      ".interaction-item__cover,.interaction-item__reference",
    );
  }

  function isProtectablePostedMedia(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isBiliStickerEmoji(el)) return false;
    if (isBiliInlineActionIcon(el)) return false;
    if (
      closestComposed(
        el,
        [
          "bili-comment-user-info",
          "bili-comment-user-sailing-card",
          "#header",
          "#ornament",
          ".user-info",
          ".user-card",
          ".user-level",
          ".level",
          ".level-icon",
          ".vip",
          ".badge",
          ".medal",
          ".pendant",
          ".ornament",
          ".sailing",
          ".nameplate",
          '[class*="level"]',
          '[class*="Level"]',
          '[class*="badge"]',
          '[class*="Badge"]',
          '[class*="medal"]',
          '[class*="Medal"]',
          '[class*="pendant"]',
          '[class*="Pendant"]',
          '[class*="ornament"]',
          '[class*="Ornament"]',
          '[class*="sailing"]',
          '[class*="Sailing"]',
          '[class*="nameplate"]',
          '[class*="Nameplate"]',
        ].join(","),
      )
    ) {
      return false;
    }

    if (
      closestComposed(
        el,
        ".interaction-item__cover,.interaction-item__reference",
      )
    )
      return true;
    if (closestComposed(el, MESSAGE_BODY_SELECTOR)) return true;
    if (closestComposed(el, CONTENT_SELECTOR)) return true;

    const raw = [
      el.getAttribute?.("src") || "",
      el.getAttribute?.("data-src") || "",
      el.getAttribute?.("srcset") || "",
      el.currentSrc || "",
      String(el.className || ""),
      String(el.parentElement?.className || ""),
    ].join(" ");

    return (
      /\/bfs\/(album|article|new_dyn|archive|im|message|mall|garb)\//i.test(
        raw,
      ) &&
      /pic|image|photo|album|cover|preview|upload|content|message|reply|dyn/i.test(
        raw,
      )
    );
  }

  function isBiliInlineActionIcon(el) {
    if (!el || el.tagName !== "IMG") return false;

    const src = [
      el.getAttribute("src") || "",
      el.getAttribute("data-src") || "",
      el.currentSrc || "",
    ].join(" ");
    const style = el.getAttribute("style") || "";

    return (
      /\/bfs\/(reply|activity-plat\/static)\//i.test(src) &&
      /--icon-(width|height|vertical-align)/i.test(style)
    );
  }

  function isBiliStickerEmoji(el) {
    if (!el || el.tagName !== "IMG") return false;

    const src = [
      el.getAttribute("src") || "",
      el.getAttribute("data-src") || "",
      el.currentSrc || "",
    ].join(" ");
    const alt = el.getAttribute("alt") || "";

    return Boolean(
      el.hasAttribute("data-emoji-pkg-id") ||
      el.hasAttribute("data-emoji-jump-url") ||
      el.hasAttribute("data-emoji-jump-title") ||
      (/\/bfs\/emote\//i.test(src) &&
        /(?:\.avif|@[\dw_]+\.avif)/i.test(src) &&
        /^\[.+\]$/.test(alt)) ||
      (/\/bfs\/garb\/item\//i.test(src) &&
        /(?:\.avif|@[\dw_]+\.avif)/i.test(src) &&
        /^\[.+表情包_.+\]$/.test(alt)),
    );
  }

  function containsBiliStickerEmoji(root) {
    if (!root || !root.querySelectorAll) return false;
    return querySelfAndDesc(root, "img").some(
      (img) => img.isConnected && isBiliStickerEmoji(img),
    );
  }

  function isInsideNativeMediaViewer(el) {
    let node = el?.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect?.();
      const isLargeFixedLayer =
        style.position === "fixed" &&
        rect &&
        rect.width >= window.innerWidth * 0.45 &&
        rect.height >= window.innerHeight * 0.45;

      if (isLargeFixedLayer) return true;

      node = node.parentElement;
    }

    return false;
  }

  function readMediaPlaceholderSize(el, mode = "large") {
    if (mode === "compact") {
      return { width: "60px", height: "60px", display: "inline-flex", mode };
    }

    if (mode === "large") {
      return { width: "208px", height: "150px", display: "inline-flex", mode };
    }

    const target = getMediaSizeTarget(el);
    const rect = target?.getBoundingClientRect?.();
    const style = target ? getComputedStyle(target) : null;
    const width =
      rectLength(rect?.width) ||
      normalizeCssLength(target?.getAttribute?.("width")) ||
      normalizeCssLength(target?.style?.width) ||
      normalizeCssLength(style?.width) ||
      "96px";
    const height =
      rectLength(rect?.height) ||
      normalizeCssLength(target?.getAttribute?.("height")) ||
      normalizeCssLength(target?.style?.height) ||
      normalizeCssLength(style?.height) ||
      "72px";
    const display =
      style?.display || getComputedStyle(el).display || "inline-block";

    return { width, height, display, mode };
  }

  function getMediaSizeTarget(el) {
    if (!el) return null;
    if (el.matches?.("img,picture,video,canvas")) return el;
    return el.querySelector?.("img,picture,video,canvas") || el;
  }

  function applyMediaPlaceholderSize(el, info) {
    const size = info.mediaSize || {};
    const display = /^(block|flex|grid|table|list-item)$/.test(
      size.display || "",
    )
      ? "flex"
      : "inline-flex";
    const position = getComputedStyle(el).position;

    el.style.setProperty("display", display, "important");
    el.style.setProperty("width", size.width || "96px", "important");
    el.style.setProperty("height", size.height || "72px", "important");
    el.style.setProperty("min-width", size.width || "96px", "important");
    el.style.setProperty("min-height", size.height || "72px", "important");
    if (!position || position === "static") {
      el.style.setProperty("position", "relative", "important");
      el.dataset.bcpSetPosition = "1";
    }
  }

  function clearMediaPlaceholderSize(el) {
    el.style.removeProperty("display");
    el.style.removeProperty("width");
    el.style.removeProperty("height");
    el.style.removeProperty("min-width");
    el.style.removeProperty("min-height");
    if (el.dataset.bcpSetPosition === "1") el.style.removeProperty("position");
    delete el.dataset.bcpSetPosition;
    delete el.dataset.bcpMediaMode;
  }

  function ensureMediaCover(el, info) {
    let cover = el.querySelector?.(":scope > [data-bcp-media-cover]");
    if (!cover) {
      cover = document.createElement("span");
      cover.setAttribute("data-bcp-media-cover", "1");
      cover.setAttribute("role", "button");
      cover.setAttribute("tabindex", "0");
      el.appendChild(cover);
    }

    cover.textContent = info?.masked || getImageMaskText();
    return cover;
  }

  function removeMediaCover(el) {
    el.querySelector?.(":scope > [data-bcp-media-cover]")?.remove();
  }

  function renderMaskedName(el, info) {
    if (!info) return;

    el.textContent = info.masked;
    markProtected(el, "name", "masked");
  }

  function renderOriginalName(el, info, state) {
    if (!info) return;

    el.innerHTML = info.html;
    markProtected(el, "name", state);
  }

  function renderMaskedComment(el, info) {
    if (!info) return;

    if (info.media) el.dataset.bcpMedia = info.media;
    else delete el.dataset.bcpMedia;

    if (info.media === "image") {
      info.nativeClickArmed = false;
      applyMediaPlaceholderSize(el, info);
      ensureMediaCover(el, info);
      if (info.mediaSize?.mode) el.dataset.bcpMediaMode = info.mediaSize.mode;
    } else {
      clearMediaPlaceholderSize(el);
      el.textContent = info.masked;
    }

    markProtected(el, "comment", "masked");
  }

  function renderPreviewMediaComment(el, info) {
    if (!info) return;

    removeMediaCover(el);
    el.dataset.bcpMedia = "image";
    info.nativeClickArmed = false;
    if (info.mediaSize?.mode) el.dataset.bcpMediaMode = info.mediaSize.mode;
    applyMediaPlaceholderSize(el, info);
    markProtected(el, "comment", "preview");
  }

  function renderOriginalComment(el, info) {
    if (!info) return;

    if (info.media === "image") {
      removeMediaCover(el);
      el.dataset.bcpMedia = "image";
      if (info.mediaSize?.mode) el.dataset.bcpMediaMode = info.mediaSize.mode;
      applyMediaPlaceholderSize(el, info);
      markProtected(el, "comment", "revealed");
      return;
    }

    clearMediaPlaceholderSize(el);
    el.innerHTML = info.html;
    if (info.media) el.dataset.bcpMedia = info.media;
    else delete el.dataset.bcpMedia;
    markProtected(el, "comment", "revealed");
  }

  function onClick(event) {
    if (!enabled) return;
    if (mediaPassThroughEvents.has(event)) return;

    const el = findProtectedFromEvent(event, ["comment"]);
    if (!el) return;

    const info = originalMap.get(el);
    if (!info || !String(info.kind).startsWith("comment")) return;

    if (info.media === "image") {
      if (el.dataset.bcpState === "masked") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        renderPreviewMediaComment(el, info);
      } else if (el.dataset.bcpState === "preview") {
        if (info.mediaToggleMode === "simple") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          renderMaskedComment(el, info);
          return;
        }

        if (!info.nativeClickArmed) {
          mediaPassThroughEvents.add(event);
          info.nativeClickArmed = true;
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        renderMaskedComment(el, info);
      } else {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        renderMaskedComment(el, info);
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    if (el.dataset.bcpState === "revealed") {
      renderMaskedComment(el, info);
    } else {
      renderOriginalComment(el, info);
    }
  }

  function onHoverStart(event) {
    if (!enabled) return;

    const el = findProtectedFromEvent(event, ["avatar", "name"]);
    if (!el) return;

    if (el.dataset.bcpState === "masked") {
      startDelayedReveal(el);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }
  }

  function onHoverEnd(event) {
    if (!enabled) return;

    const el = findProtectedFromEvent(event, ["avatar", "name"]);
    if (!el) return;

    const related = event.relatedTarget;
    if (
      related &&
      related.nodeType === Node.ELEMENT_NODE &&
      el.contains(related)
    )
      return;

    const timer = hoverTimerMap.get(el);
    if (timer) {
      clearTimeout(timer);
      hoverTimerMap.delete(el);
    }

    if (el.dataset.bcpState !== "hover") return;

    const info = originalMap.get(el);
    if (!info) return;

    delete el.dataset.bcpAllowHover;

    if (info.kind === "avatar-img") renderMaskedAvatarImg(el, info);
    else if (info.kind === "avatar-box") renderMaskedAvatarBox(el, info);
    else if (info.kind === "name") renderMaskedName(el, info);
  }

  function startDelayedReveal(el) {
    if (hoverTimerMap.has(el)) return;

    const timer = window.setTimeout(() => {
      hoverTimerMap.delete(el);

      if (!enabled) return;
      if (!el.isConnected) return;
      if (el.dataset.bcpState !== "masked") return;
      if (!isProtectedHovering(el)) return;

      const info = originalMap.get(el);
      if (!info) return;

      if (info.kind === "avatar-img")
        renderOriginalAvatarImg(el, info, "hover");
      else if (info.kind === "avatar-box")
        renderOriginalAvatarBox(el, info, "hover");
      else if (info.kind === "name") renderOriginalName(el, info, "hover");

      el.dataset.bcpAllowHover = "1";
      setTimeout(() => dispatchNativeHover(el), 30);
    }, CFG.hoverDelay);

    hoverTimerMap.set(el, timer);
  }

  function dispatchNativeHover(el) {
    if (!el || !el.isConnected) return;

    const target = closestComposed(el, 'a[href*="space.bilibili.com"]') || el;

    const pointerEvent = new PointerEvent("pointerover", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "mouse",
    });

    const mouseOverEvent = new MouseEvent("mouseover", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    });

    const mouseEnterEvent = new MouseEvent("mouseenter", {
      bubbles: false,
      cancelable: true,
      composed: true,
      view: window,
    });

    target.dispatchEvent(pointerEvent);
    target.dispatchEvent(mouseOverEvent);
    target.dispatchEvent(mouseEnterEvent);
  }

  function findProtectedFromEvent(event, allowedKinds) {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];

    for (const node of path) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      const coverFor = node.dataset?.bcpAvatarCoverFor;
      if (coverFor && allowedKinds.includes("avatar")) {
        const source = findAvatarCoverSource(coverFor);
        if (source) return source;
      }

      const kind = node.dataset?.bcpKind;
      if (kind && allowedKinds.includes(kind)) return node;
    }

    const selector = allowedKinds
      .map((kind) => `[data-bcp-kind="${kind}"]`)
      .join(",");
    return event.target?.closest?.(selector) || null;
  }

  function isProtectedHovering(el) {
    if (typeof el?.matches === "function" && el.matches(":hover")) return true;

    const coverId = el?.dataset?.bcpAvatarCoverId;
    if (!coverId) return false;

    for (const root of new Set([document, ...knownRoots])) {
      const cover = findAvatarCover(root, coverId);
      if (cover?.matches?.(":hover")) return true;
    }

    return false;
  }

  function findAvatarCoverSource(coverId) {
    if (!coverId) return null;

    for (const root of new Set([document, ...knownRoots])) {
      const candidates =
        root.querySelectorAll?.("[data-bcp-avatar-cover-id]") || [];
      for (const candidate of candidates) {
        if (
          candidate.dataset.bcpAvatarCoverId === coverId &&
          candidate.dataset.bcpKind === "avatar"
        ) {
          return candidate;
        }
      }
    }

    return null;
  }

  function restoreAll() {
    for (const root of new Set([document, ...knownRoots])) {
      for (const el of querySelfAndDesc(root, "[data-bcp-kind]")) {
        restoreElementPermanently(el);
      }
    }
  }

  function restoreElementPermanently(el) {
    const info = originalMap.get(el);
    if (!info) {
      clearProtected(el);
      return;
    }

    if (info.kind === "avatar-img") {
      renderOriginalAvatarImg(el, info, "plain");
      clearProtected(el);
    } else if (info.kind === "avatar-box") {
      renderOriginalAvatarBox(el, info, "plain");
      clearProtected(el);
    } else if (info.kind === "name") {
      el.innerHTML = info.html;
      clearProtected(el);
    } else if (info.kind === "comment-block") {
      if (info.media === "image") {
        removeMediaCover(el);
      } else {
        el.innerHTML = info.html;
      }
      clearProtected(el);
    } else if (info.kind === "comment-piece") {
      if (info.media === "image") {
        removeMediaCover(el);
        clearProtected(el);
        const node = info.node?.isConnected
          ? info.node
          : el.querySelector?.("picture,video,canvas,img");
        if (node) el.replaceWith(node);
        else el.replaceWith(htmlToFragment(info.html));
      } else {
        const fragment = htmlToFragment(info.html);
        el.replaceWith(fragment);
      }
    }
  }

  function clearProtected(el) {
    removeAvatarCover(el);
    if (el.dataset.bcpMedia === "image") {
      removeMediaCover(el);
      clearMediaPlaceholderSize(el);
    }
    delete el.dataset.bcpKind;
    delete el.dataset.bcpState;
    delete el.dataset.bcpAllowHover;
    delete el.dataset.bcpMedia;
    delete el.dataset.bcpMediaMode;
    el.classList.remove("bcp-masked-avatar");
    el.classList.remove("bcp-avatar-box-mask");
  }

  function markProtected(el, kind, state) {
    el.dataset.bcpKind = kind;
    el.dataset.bcpState = state;
  }

  function readImgAttrs(img) {
    return {
      src: img.getAttribute("src"),
      dataSrc: img.getAttribute("data-src"),
      srcset: img.getAttribute("srcset"),
      sizes: img.getAttribute("sizes"),
    };
  }

  function restoreAttr(el, attr, value) {
    if (value === null || value === undefined || value === "")
      el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  }

  function isMaskedAvatarImg(img) {
    return (img.getAttribute("src") || "") === MASK_AVATAR;
  }

  function isAvatarImgLike(img) {
    if (!img || img.tagName !== "IMG") return false;
    if (closestComposed(img, '[data-bcp-kind="comment"]')) return false;
    if (closestComposed(img, "bili-avatar")) return true;

    const raw = [
      img.getAttribute("src") || "",
      img.getAttribute("data-src") || "",
      img.getAttribute("srcset") || "",
      img.currentSrc || "",
      String(img.className || ""),
      String(closestComposed(img, AVATAR_BOX_SELECTOR)?.className || ""),
    ].join(" ");

    return (
      /\/bfs\/face\//.test(raw) || /avatar|face|user-face|reply-face/i.test(raw)
    );
  }

  function isAvatarBoxLike(box) {
    if (!box || box.nodeType !== Node.ELEMENT_NODE) return false;
    if (box.tagName === "IMG") return false;
    if (closestComposed(box, '[data-bcp-kind="comment"]')) return false;
    if (normalizeText(box.textContent || "")) return false;
    if (box.id === "user-avatar") return true;
    if (
      box.matches?.("a[data-user-profile-id],a[data-user-profile-spmid-follow]")
    )
      return true;
    if (box.localName === "bili-avatar") return true;
    if (box.querySelector?.("bili-avatar")) return true;

    const cls = String(box.className || "");
    const hasAvatarClass = /avatar|face|user-face|reply-face/i.test(cls);
    const hasAvatarImg = Boolean(box.querySelector?.(AVATAR_IMG_SELECTOR));
    const hasFaceBg = /url\(/.test(getComputedStyle(box).backgroundImage || "");

    return hasAvatarClass || hasAvatarImg || hasFaceBg;
  }

  function isNameLike(el) {
    if (!inCommentArea(el)) return false;
    if (closestComposed(el, EXCLUDE_SELECTOR)) return false;
    if (closestComposed(el, '[data-bcp-kind="comment"]')) return false;

    const text = normalizeText(el.textContent || "");
    if (!text || text.length > 40) return false;

    if (isMessagePage() && isMessageNameCandidate(el, text)) return true;
    if (isCommentMentionLike(el, text)) return true;

    if (closestComposed(el, CONTENT_SELECTOR)) return false;

    const href = el.getAttribute?.("href") || "";
    const cls = String(el.className || "");

    return (
      href.includes("space.bilibili.com") || /name|uname|author|user/i.test(cls)
    );
  }

  function isCommentMentionLike(
    el,
    text = normalizeText(el.textContent || ""),
  ) {
    if (isMessagePage()) return false;
    if (!text.startsWith("@")) return false;

    const href = el.getAttribute?.("href") || "";
    const type = el.getAttribute?.("data-type") || "";
    const userId = el.getAttribute?.("data-user-profile-id") || "";

    return (
      type === "mention" &&
      Boolean(userId || href.includes("space.bilibili.com"))
    );
  }

  function isMessageNameCandidate(
    el,
    text = normalizeText(el.textContent || ""),
  ) {
    if (!inMessageArea(el)) return false;
    if (!text || isMetaText(text)) return false;
    if (MESSAGE_TITLE_ACTION_RE.test(text)) return false;

    const href = el.getAttribute?.("href") || "";
    const cls = String(el.className || "");

    return (
      text.startsWith("@") ||
      href.includes("space.bilibili.com") ||
      /name|nick|user|author/i.test(cls) ||
      isMessageMentionLike(el)
    );
  }

  function isMessageMentionLike(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const text = normalizeText(el.textContent || "");
    if (!text.startsWith("@")) return false;
    if (!inMessageArea(el)) return false;

    const href = el.getAttribute?.("href") || "";
    const cls = String(el.className || "");

    return (
      href.includes("space.bilibili.com") ||
      /name|nick|user|at|mention/i.test(cls) ||
      el.tagName === "A"
    );
  }

  function isContentBlockLike(el) {
    if (!inCommentArea(el)) return false;
    if (closestComposed(el, EXCLUDE_SELECTOR)) return false;
    if (closestComposed(el, NAME_SELECTOR)) return false;
    if (closestComposed(el, '[data-bcp-kind="name"]')) return false;
    if (isNameLike(el)) return false;

    if (
      !closestComposed(el, COMMENT_ITEM_SELECTOR) &&
      !closestComposed(el, SCOPE_SELECTOR)
    )
      return false;

    const text = normalizeText(el.textContent || "");
    if (isMetaText(text)) return false;

    return countVisibleUnits(el) > 0;
  }

  function getScanAreas(root) {
    const out = [];

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(SCOPE_SELECTOR)) {
      out.push(root);
    }

    if (root.querySelectorAll) {
      out.push(...root.querySelectorAll(SCOPE_SELECTOR));
    }

    if (
      !out.length &&
      root.nodeType === Node.ELEMENT_NODE &&
      inCommentArea(root)
    ) {
      out.push(root);
    }

    return [...new Set(out)].filter(Boolean);
  }

  function isMetaText(text) {
    if (!text) return true;
    if (
      /^(回复|举报|分享|删除|移除|点赞|点踩|赞|踩|已赞|置顶|UP主|展开|收起|查看更多|点击查看)$/.test(
        text,
      )
    )
      return true;
    if (/^[，,、]\s*点击查看$/.test(text)) return true;
    if (
      /^(、|，|,)?\s*(等)?总计\d+人赞了我的(视频|评论|动态|专栏|投稿)$/.test(
        text,
      )
    )
      return true;
    if (/^(、|，|,)?\s*赞了我的(视频|评论|动态|专栏|投稿)$/.test(text))
      return true;
    if (/^共\d+条回复/.test(text)) return true;
    if (/^IP属地[:：]/.test(text)) return true;
    if (/^\d+\s*(秒|分钟|小时|天|周|个月|年)前$/.test(text)) return true;
    if (/^刚刚$/.test(text)) return true;
    if (/^(今天|昨天|前天)\s*\d{1,2}:\d{2}$/.test(text)) return true;
    if (/^\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}$/.test(text)) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
    if (/^\d{1,2}:\d{2}$/.test(text)) return true;
    if (/^\d+\s*$/.test(text)) return true;
    return false;
  }

  function isReplyExpandSeparatorNode(node) {
    const text = normalizeText(node?.nodeValue || "");
    if (!/^[，,、]$/.test(text)) return false;

    const parentText = normalizeText(node.parentElement?.textContent || "");
    if (
      parentText.length <= 40 &&
      /^共\d+条回复[，,、]?\s*点击查看$/.test(parentText)
    )
      return true;

    const before = collectSiblingText(node, "previous");
    const after = collectSiblingText(node, "next");
    if (/共\d+条回复$/.test(before) && /^点击查看/.test(after)) return true;

    const context =
      closestComposed(node.parentElement, COMMENT_ITEM_SELECTOR) ||
      closestComposed(node.parentElement, SCOPE_SELECTOR) ||
      node.parentElement;
    const nodes = collectContextTextNodes(context);
    const index = nodes.indexOf(node);
    if (index < 0) return false;

    const prev = normalizeText(
      nodes
        .slice(Math.max(0, index - 8), index)
        .map((n) => n.nodeValue || "")
        .join(""),
    );
    const next = normalizeText(
      nodes
        .slice(index + 1, index + 9)
        .map((n) => n.nodeValue || "")
        .join(""),
    );
    return /共\d+条回复$/.test(prev) && /^点击查看/.test(next);
  }

  function collectSiblingText(node, direction) {
    const parts = [];
    let sibling =
      direction === "previous" ? node?.previousSibling : node?.nextSibling;
    let guard = 0;

    while (sibling && guard < 5) {
      guard += 1;
      const text = normalizeText(
        sibling.textContent || sibling.nodeValue || "",
      );
      if (text) {
        if (direction === "previous") parts.unshift(text);
        else parts.push(text);
      }
      sibling =
        direction === "previous"
          ? sibling.previousSibling
          : sibling.nextSibling;
    }

    return normalizeText(parts.join(""));
  }

  function collectContextTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !normalizeText(node.nodeValue))
          return NodeFilter.FILTER_REJECT;
        if (
          closestComposed(
            parent,
            'script,style,textarea,input,[contenteditable="true"]',
          )
        )
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode() && nodes.length < 500)
      nodes.push(walker.currentNode);
    return nodes;
  }

  function inCommentArea(el) {
    return Boolean(closestComposed(el, SCOPE_SELECTOR));
  }

  function inMessageArea(el) {
    return (
      isMessagePage() && Boolean(closestComposed(el, MESSAGE_AREA_SELECTOR))
    );
  }

  function isDirectMessageChatArea(el) {
    if (!isMessagePage() || !el) return false;
    if (
      closestComposed(
        el,
        ".interaction-item__content,.interaction-item__msg,.interaction-item__reference,.interaction-item__cover,.at-item,.notify-item",
      )
    ) {
      return false;
    }

    const route =
      `${location.pathname || ""} ${location.hash || ""}`.toLowerCase();
    if (/reply|at|love|like|praise|system/.test(route)) return false;
    if (/whisper|chat|im/.test(route)) return true;

    return Boolean(
      closestComposed(
        el,
        [
          ".im-container",
          '[class*="_ChatContent_"]',
          '[class*="_MessageList_"]',
          '[class*="_Msg_"]',
          '[class*="_SessionList_"]',
        ].join(","),
      ),
    );
  }

  function isMessagePage() {
    return location.hostname === "message.bilibili.com";
  }

  function countVisibleUnits(el) {
    const clone = el.cloneNode(true);

    clone
      .querySelectorAll?.(
        [
          "script",
          "style",
          "textarea",
          "input",
          "button",
          ".info",
          ".reply-info",
          ".sub-reply-info",
          ".operation",
          ".comment-actions",
          ".toolbar",
          ".action",
          ".like",
          ".hate",
          ".time",
        ].join(","),
      )
      ?.forEach((n) => n.remove());

    clone.querySelectorAll?.("img")?.forEach((n) => {
      if (isBiliStickerEmoji(n)) n.remove();
    });

    clone.querySelectorAll?.(EMOJI_SELECTOR)?.forEach((n) => {
      n.replaceWith(document.createTextNode(getCommentMaskText()));
    });

    return countTextUnits(clone.textContent || "");
  }

  function countTextUnits(text) {
    return splitGraphemes(text).filter((ch) => !/\s/u.test(ch)).length;
  }

  function getCommentMaskLimit(el) {
    if (
      isMessagePage() &&
      closestComposed(
        el,
        ".interaction-item__cover,.interaction-item__reference",
      )
    )
      return 4;
    return CFG.maxCommentMaskLength;
  }

  function buildMiao(count, max = CFG.maxCommentMaskLength) {
    const n = max > 0 ? max : Math.max(1, count);
    return getCommentMaskText().repeat(n);
  }

  function maskName(text) {
    return normalizeText(text)
      ? CFG.nameMaskChar.repeat(CFG.maxNameMaskLength)
      : CFG.nameMaskChar;
  }

  function isPureMiao(text) {
    const s = normalizeText(text);
    const tokens = [
      ...Object.values(I18N).map((pack) => pack.commentMask),
      ...Object.values(PETS).map((item) => item.sound),
    ].filter(Boolean);
    return (
      Boolean(s) &&
      tokens.some((token) => {
        return new RegExp(`^(?:${escapeRegExp(token)})+$`).test(s);
      })
    );
  }

  function getCommentMaskText() {
    return (PETS[pet] || PETS[CFG.defaultPet]).sound;
  }

  function getImageMaskText() {
    return (I18N[language] || I18N[CFG.defaultLanguage]).imageMask;
  }

  function getSendInterceptLabel() {
    return sendInterceptEnabled ? "发送拦截：开" : "发送拦截：关";
  }

  function getLanguageName(value = language) {
    const names = {
      zh: "中文",
      ko: "한국어",
      en: "English",
      ja: "日本語",
    };
    return names[value] || names[CFG.defaultLanguage];
  }

  function getPetName(value = pet) {
    return (PETS[value] || PETS[CFG.defaultPet]).name;
  }

  function getSendInterceptMaskText() {
    return getCommentMaskText().repeat(CFG.sendInterceptMaskLength);
  }

  function getSendInterceptPlaceholder() {
    return `当前已开启屏蔽自己发送评论，所有发出去的文字都会变成${getCommentMaskText().repeat(3)}`;
  }

  function syncAllCommentEditorPlaceholders() {
    for (const root of new Set([document, ...knownRoots])) {
      syncCommentEditorPlaceholders(root);
    }
  }

  function syncCommentEditorPlaceholders(root) {
    if (!root) return;
    const placeholders = querySelfAndDesc(
      root,
      ".brt-placeholder,[data-bcp-send-placeholder]",
    );

    for (const el of placeholders) {
      if (!isCommentEditorPlaceholder(el)) continue;
      if (sendInterceptEnabled) maskCommentEditorPlaceholder(el);
      else restoreCommentEditorPlaceholder(el);
    }
  }

  function isCommentEditorPlaceholder(el) {
    return Boolean(
      el?.classList?.contains("brt-placeholder") &&
        closestComposed(
          el,
          ".brt-root,#editor,#input,bili-comment-rich-textarea",
        ),
    );
  }

  function maskCommentEditorPlaceholder(el) {
    if (!el.dataset.bcpSendPlaceholderOriginal) {
      el.dataset.bcpSendPlaceholderOriginal = el.textContent || "";
    }
    el.dataset.bcpSendPlaceholder = "1";
    const placeholder = getSendInterceptPlaceholder();
    if (el.textContent !== placeholder) {
      el.textContent = placeholder;
    }
  }

  function restoreCommentEditorPlaceholder(el) {
    if (el.dataset.bcpSendPlaceholder !== "1") return;
    el.textContent = el.dataset.bcpSendPlaceholderOriginal || "";
    delete el.dataset.bcpSendPlaceholder;
    delete el.dataset.bcpSendPlaceholderOriginal;
  }

  function syncSendInterceptBridgeState() {
    writeLocalState(CFG.sendInterceptKey, sendInterceptEnabled ? "1" : "0");
    writeLocalState(CFG.languageKey, language);
    writeLocalState(CFG.petKey, pet);
  }

  function installSendInterceptHook() {
    const petSounds = Object.fromEntries(
      Object.entries(PETS).map(([key, item]) => [key, item.sound]),
    );
    const payload = {
      sendKey: CFG.sendInterceptKey,
      petKey: CFG.petKey,
      defaultPet: CFG.defaultPet,
      length: CFG.sendInterceptMaskLength,
      petSounds,
    };

    const code = `(() => {
      const cfg = ${JSON.stringify(payload)};
      if (window.__BCP_SEND_INTERCEPT_INSTALLED__) return;
      window.__BCP_SEND_INTERCEPT_INSTALLED__ = true;

      const targetReplyUrl = (url) => {
        const raw = String(url || '');
        return /\\/x\\/v2\\/reply\\/(add|reply)(?:\\?|$|\\/)/.test(raw)
          || /\\/x\\/v2\\/reply\\/wbi\\/(add|reply)(?:\\?|$|\\/)/.test(raw);
      };

      const isEnabled = () => {
        try {
          return localStorage.getItem(cfg.sendKey) === '1';
        } catch (_) {
          return false;
        }
      };

      const maskText = () => {
        let pet = cfg.defaultPet;
        try {
          pet = localStorage.getItem(cfg.petKey) || cfg.defaultPet;
        } catch (_) {}
        return String(cfg.petSounds[pet] || cfg.petSounds[cfg.defaultPet] || '喵').repeat(cfg.length);
      };

      const rewriteSearchParams = (params) => {
        if (!params.has('message')) return null;
        params.set('message', maskText());
        return params;
      };

      const rewriteBody = (body) => {
        if (!isEnabled() || body == null) return body;

        try {
          if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            const next = rewriteSearchParams(new URLSearchParams(body));
            return next || body;
          }
        } catch (_) {}

        try {
          if (typeof FormData !== 'undefined' && body instanceof FormData) {
            if (!body.has('message')) return body;
            const next = new FormData();
            body.forEach((value, key) => {
              next.append(key, key === 'message' ? maskText() : value);
            });
            return next;
          }
        } catch (_) {}

        if (typeof body === 'string') {
          try {
            const next = rewriteSearchParams(new URLSearchParams(body));
            return next ? next.toString() : body;
          } catch (_) {
            return body;
          }
        }

        return body;
      };

      const nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function') {
        window.fetch = function bcpFetch(input, init) {
          let nextInput = input;
          let nextInit = init;

          try {
            const url = typeof input === 'string' ? input : input?.url;
            if (targetReplyUrl(url) && init && Object.prototype.hasOwnProperty.call(init, 'body')) {
              nextInit = { ...init, body: rewriteBody(init.body) };
            }
          } catch (_) {}

          return nativeFetch.call(this, nextInput, nextInit);
        };
      }

      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto && proto.open && proto.send) {
        const nativeOpen = proto.open;
        const nativeSend = proto.send;

        proto.open = function bcpOpen(method, url) {
          this.__bcpReplyUrl = url;
          return nativeOpen.apply(this, arguments);
        };

        proto.send = function bcpSend(body) {
          let nextBody = body;
          try {
            if (targetReplyUrl(this.__bcpReplyUrl)) {
              nextBody = rewriteBody(body);
            }
          } catch (_) {}
          return nativeSend.call(this, nextBody);
        };
      }
    })();`;

    const script = document.createElement("script");
    script.textContent = code;
    (document.documentElement || document.head || document).appendChild(script);
    script.remove();
  }

  function splitGraphemes(text) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
      return [...segmenter.segment(text)].map((item) => item.segment);
    }
    return Array.from(text);
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function closestComposed(el, selector) {
    let node = el;
    let guard = 0;

    while (node && guard < 200) {
      guard += 1;

      if (node.nodeType === Node.ELEMENT_NODE && node.matches?.(selector)) {
        return node;
      }

      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }

      const root = node.getRootNode?.();
      node = root && root.host ? root.host : null;
    }

    return null;
  }

  function querySelfAndDesc(root, selector) {
    const out = [];

    try {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) {
        out.push(root);
      }

      if (root.querySelectorAll) {
        out.push(...root.querySelectorAll(selector));
      }
    } catch (_) {}

    return out;
  }

  function collectTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !normalizeText(node.nodeValue))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, "[data-bcp-kind]"))
          return NodeFilter.FILTER_REJECT;
        if (closestComposed(parent, EXCLUDE_SELECTOR))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function scanShadowRoots(root) {
    if (!root || !root.querySelectorAll) return;

    if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) {
      observeRoot(root.shadowRoot);
      enqueue(root.shadowRoot);
    }

    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        enqueue(el.shadowRoot);
      }
    }
  }

  function depth(el) {
    let n = el;
    let d = 0;

    while (n && d < 200) {
      d += 1;

      if (n.parentElement) {
        n = n.parentElement;
      } else {
        const root = n.getRootNode?.();
        n = root && root.host ? root.host : null;
      }
    }

    return d;
  }

  function htmlToFragment(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // 直播跟车：房间设置持久保存，计时器和待发送内容不持久保存。
  function installLiveFollow() {
    if (window.top !== window.self) return;
    const ROW = '.chat-item.danmaku-item[data-uid][data-danmaku]';
    const STORAGE_PREFIX = 'bcp.liveFollow.room.v2.';
    const MAX_TARGETS = 3, MAX_QUEUE = 12, MAX_QUEUE_AGE = 15000;
    const MIN_INTERVAL = 2000, REPEAT_WINDOW = 15000, ACK_TIMEOUT = 8000;
    const seen = new Map(), recentTexts = new Map(), watchedMenus = new WeakSet(), watchedRooms = new Set();
    let room = roomId(), settings = readSettings(room);
    let chat = null, chatObserver = null, awaitingRoom = false;
    let candidate = null, menuQueued = false, syncQueued = false;
    let toolbarButton = null, panel = null, feedback = null, feedbackTimer = 0;
    let randomTimer = 0, randomReady = false, randomDue = 0;
    let pending = null, session = 0, lastSentAt = -Infinity, pageActive = true;
    const sendQueue = [];
    let queueTimer = 0, canonicalRoom = null;
    let lastDetail = '', submitted = 0, acknowledged = 0;
    const COVER_COLORS = [['黑色', '#000000'], ['白色', '#ffffff'], ['蓝色', '#2563eb'], ['灰色', '#64748b'], ['粉色', '#f4a7b9']];
    const cover = {enabled: false, color: '#000000', image: '', name: '', locked: false,
      rect: {x: .55, y: .12, width: .35, height: .35}};
    let coverLayer = null, coverMask = null, coverImage = null, coverVideo = null, coverHost = null;
    let coverHostPosition = null, coverResize = null, coverFrame = 0, coverGesture = null, coverFileVersion = 0;
    const STYLE_PREFIX = 'bcp.liveStyle.room.v1.', STYLE_CHANNELS = ['rgb', 'r', 'g', 'b'];
    const styleTargets = new Map(), watchedStyleRooms = new Set();
    let styleSettings = readStyleSettings(room), styleSvg = null, styleFilters = null, styleDialog = null, styleEditor = null;
    let stylePaintFrame = 0, stylePreviewFrame = 0;

    // 托管只处理页面上的视觉遮挡，不改变视频流，也不读取或上传所选图片。
    function fitCoverRect(rect, width, height) {
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      const number = (n, fallback) => Number.isFinite(n) ? n : fallback;
      width = Math.max(0, number(width, 0)); height = Math.max(0, number(height, 0));
      const w = clamp(number(rect.width, width * .35), Math.min(24, width), width);
      const h = clamp(number(rect.height, height * .35), Math.min(24, height), height);
      return {x: clamp(number(rect.x, 0), 0, width - w), y: clamp(number(rect.y, 0), 0, height - h), width: w, height: h};
    }
    function dragCoverRect(rect, edge, dx, dy, width, height) {
      const start = fitCoverRect(rect, width, height);
      if (edge === 'move') return fitCoverRect({...start, x: start.x + dx, y: start.y + dy}, width, height);
      let left = start.x, top = start.y, right = left + start.width, bottom = top + start.height;
      const minW = Math.min(24, width), minH = Math.min(24, height);
      if (edge.includes('w')) left = Math.max(0, Math.min(right - minW, left + dx));
      if (edge.includes('e')) right = Math.min(width, Math.max(left + minW, right + dx));
      if (edge.includes('n')) top = Math.max(0, Math.min(bottom - minH, top + dy));
      if (edge.includes('s')) bottom = Math.min(height, Math.max(top + minH, bottom + dy));
      return {x: left, y: top, width: right - left, height: bottom - top};
    }
    function coverPictureBox(width, height, sourceWidth, sourceHeight, fit, position = '50% 50%') {
      let w = width, h = height;
      if (sourceWidth > 0 && sourceHeight > 0 && (fit === 'contain' || fit === 'scale-down')) {
        const scale = Math.min(width / sourceWidth, height / sourceHeight, fit === 'scale-down' ? 1 : Infinity);
        w = sourceWidth * scale; h = sourceHeight * scale;
      }
      const parts = position.split(/\s+/);
      function offset(value, gap) {
        if (value === 'left' || value === 'top') return 0;
        if (value === 'right' || value === 'bottom') return gap;
        if (/^-?[\d.]+%$/.test(value)) return gap * Math.max(0, Math.min(1, parseFloat(value) / 100));
        if (/^-?[\d.]+px$/.test(value)) return Math.max(0, Math.min(gap, parseFloat(value)));
        return gap / 2;
      }
      return {x: offset(parts[0], width - w), y: offset(parts[1] || '50%', height - h), width: w, height: h};
    }
    function coverPixels() {
      const width = parseFloat(coverLayer?.style.width) || 0, height = parseFloat(coverLayer?.style.height) || 0;
      return {width, height, rect: fitCoverRect({x: cover.rect.x * width, y: cover.rect.y * height,
        width: cover.rect.width * width, height: cover.rect.height * height}, width, height)};
    }
    function paintCover() {
      if (!coverMask || !coverLayer) return;
      const {rect} = coverPixels();
      Object.assign(coverMask.style, {left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, backgroundColor: cover.color});
      coverMask.dataset.locked = String(cover.locked);
      coverMask.tabIndex = cover.locked ? -1 : 0;
      if (coverImage.getAttribute('src') !== (cover.image || null)) {
        if (cover.image) coverImage.src = cover.image; else coverImage.removeAttribute('src');
      }
      coverImage.hidden = !cover.image;
      const button = coverMask.querySelector('[data-bcp-cover-lock]');
      button.setAttribute('aria-label', cover.locked ? '解锁托管遮挡' : '锁定托管遮挡');
      button.setAttribute('aria-pressed', String(cover.locked));
      setText(button, cover.locked ? '解锁' : '锁定');
    }
    function finishCoverGesture() {
      const gesture = coverGesture; coverGesture = null;
      if (gesture && coverMask?.hasPointerCapture(gesture.id)) coverMask.releasePointerCapture(gesture.id);
      coverMask?.removeAttribute('data-dragging');
    }
    function beginCoverGesture(event) {
      if (cover.locked || event.button !== 0 || event.isPrimary === false || event.target.closest('button')) return;
      const {width, height, rect} = coverPixels();
      if (!width || !height) return;
      finishCoverGesture(); event.preventDefault(); event.stopPropagation();
      coverGesture = {id: event.pointerId, edge: event.target.dataset.bcpCoverHandle || 'move',
        x: event.clientX, y: event.clientY, rect, width, height};
      coverMask.setPointerCapture(event.pointerId); coverMask.dataset.dragging = 'true';
    }
    function moveCoverGesture(event) {
      const gesture = coverGesture;
      if (!gesture || event.pointerId !== gesture.id || cover.locked) return;
      event.preventDefault(); event.stopPropagation();
      const rect = dragCoverRect(gesture.rect, gesture.edge, event.clientX - gesture.x, event.clientY - gesture.y, gesture.width, gesture.height);
      cover.rect = {x: rect.x / gesture.width, y: rect.y / gesture.height, width: rect.width / gesture.width, height: rect.height / gesture.height};
      paintCover();
    }
    function detachCover() {
      finishCoverGesture(); coverResize?.disconnect(); coverResize = null;
      if (coverFrame) cancelAnimationFrame(coverFrame); coverFrame = 0;
      coverVideo?.removeEventListener('loadedmetadata', scheduleCoverLayout);
      coverVideo?.removeEventListener('resize', scheduleCoverLayout);
      coverLayer?.remove(); coverLayer = coverMask = coverImage = coverVideo = null;
      coverHost?.removeAttribute('data-bcp-cover-host');
      if (coverHostPosition !== null && coverHost?.style.position === 'relative') {
        if (coverHostPosition) coverHost.style.position = coverHostPosition; else coverHost.style.removeProperty('position');
      }
      coverHost = null; coverHostPosition = null;
    }
    function clearCoverImage() {
      coverFileVersion += 1;
      if (cover.image) URL.revokeObjectURL(cover.image);
      cover.image = ''; cover.name = '';
      const input = panel?.querySelector('[data-bcp-cover-file]'); if (input) input.value = '';
    }
    function resetCover() {
      detachCover(); clearCoverImage(); cover.enabled = false; cover.locked = false;
      cover.rect = {x: .55, y: .12, width: .35, height: .35};
      renderCoverControls();
    }
    function chooseCoverColor(color) {
      if (!COVER_COLORS.some(item => item[1] === color)) return;
      clearCoverImage(); cover.color = color; paintCover(); renderCoverControls();
    }
    async function chooseCoverFile(file) {
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) {
        tell('请选择 20 MB 以内的 JPG、PNG、WebP 等图片。'); return;
      }
      const version = ++coverFileVersion, url = URL.createObjectURL(file), image = new Image();
      let timeout;
      try {
        await new Promise((resolve, reject) => {
          image.onload = resolve; image.onerror = () => reject(new Error('图片无法读取'));
          timeout = setTimeout(() => reject(new Error('图片读取超时')), 15000); image.src = url;
        });
        if (version !== coverFileVersion) { URL.revokeObjectURL(url); return; }
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片尺寸过大');
        if (cover.image) URL.revokeObjectURL(cover.image);
        cover.image = url; cover.name = file.name; paintCover(); renderCoverControls();
      } catch (_) {
        URL.revokeObjectURL(url);
        if (version === coverFileVersion) tell('图片无法读取或尺寸过大，请换一张图片。');
      } finally { clearTimeout(timeout); image.onload = image.onerror = null; }
    }
    function renderCoverControls() {
      if (!panel) return;
      const toggle = panel.querySelector('[data-bcp-cover-toggle]');
      toggle.setAttribute('aria-checked', String(cover.enabled));
      setText(toggle.querySelector('.bcp-switch-word'), cover.enabled ? '开' : '关');
      for (const button of panel.querySelectorAll('[data-bcp-cover-color]')) button.setAttribute('aria-pressed', String(!cover.image && button.dataset.bcpCoverColor === cover.color));
      setText(panel.querySelector('[data-bcp-cover-status]'), cover.enabled ? coverLayer ? '画面内拖动 · 八向缩放 · 移入可锁定' : '等待直播画面' : '在直播画面内遮挡一部分内容');
      setText(panel.querySelector('[data-bcp-cover-filename]'), cover.name || '图片仅在本页使用，不上传');
      if (!panel.hidden) positionPanel();
    }
    function attachCover(video, host) {
      detachCover(); coverVideo = video; coverHost = host;
      if (getComputedStyle(host).position === 'static') { coverHostPosition = host.style.position; host.style.position = 'relative'; }
      host.setAttribute('data-bcp-cover-host', '');
      coverLayer = document.createElement('div'); coverLayer.id = 'bcp-live-cover-layer';
      coverMask = document.createElement('div'); coverMask.id = 'bcp-live-cover';
      coverMask.setAttribute('role', 'group'); coverMask.setAttribute('aria-label', '托管遮挡，可拖动和八向缩放');
      coverImage = document.createElement('img'); coverImage.alt = ''; coverImage.draggable = false;
      coverMask.appendChild(coverImage);
      const tools = document.createElement('div'); tools.className = 'bcp-cover-tools';
      const lock = document.createElement('button'); lock.type = 'button'; lock.setAttribute('data-bcp-cover-lock', '');
      lock.addEventListener('click', event => { event.stopPropagation(); finishCoverGesture(); cover.locked = !cover.locked; paintCover(); });
      tools.appendChild(lock); coverMask.appendChild(tools);
      for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
        const handle = document.createElement('span'); handle.dataset.bcpCoverHandle = edge; handle.setAttribute('aria-hidden', 'true'); coverMask.appendChild(handle);
      }
      coverMask.addEventListener('pointerdown', beginCoverGesture);
      coverMask.addEventListener('pointermove', moveCoverGesture);
      coverMask.addEventListener('pointerup', finishCoverGesture);
      coverMask.addEventListener('pointercancel', finishCoverGesture);
      coverMask.addEventListener('lostpointercapture', finishCoverGesture);
      // 不让播放器将拖拽结尾、双击或右键误当作播放、全屏等操作。
      for (const type of ['click', 'dblclick', 'contextmenu']) coverMask.addEventListener(type, event => { event.stopPropagation(); if (type !== 'click') event.preventDefault(); });
      coverMask.addEventListener('keydown', event => {
        if (event.target !== coverMask || cover.locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const {rect, width, height} = coverPixels(), step = event.shiftKey ? 10 : 1;
        const next = dragCoverRect(rect, 'move', event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, width, height);
        if (width && height) cover.rect = {x: next.x / width, y: next.y / height, width: next.width / width, height: next.height / height};
        paintCover();
      });
      coverLayer.appendChild(coverMask); host.appendChild(coverLayer);
      if (typeof ResizeObserver === 'function') {
        coverResize = new ResizeObserver(scheduleCoverLayout); coverResize.observe(video); if (video !== host) coverResize.observe(host);
      }
      video.addEventListener('loadedmetadata', scheduleCoverLayout); video.addEventListener('resize', scheduleCoverLayout);
    }
    function layoutCover() {
      coverFrame = 0;
      if (!coverLayer || !coverVideo?.isConnected || !coverHost?.isConnected) return;
      const videoRect = coverVideo.getBoundingClientRect(), hostRect = coverHost.getBoundingClientRect();
      const style = getComputedStyle(coverVideo), innerVideo = coverVideo.querySelector('video');
      const box = coverPictureBox(videoRect.width, videoRect.height, coverVideo.videoWidth || innerVideo?.videoWidth,
        coverVideo.videoHeight || innerVideo?.videoHeight, style.objectFit, style.objectPosition);
      const available = visible(coverVideo) && box.width > 0 && box.height > 0 && !(document.fullscreenElement === coverVideo);
      coverLayer.hidden = !available;
      if (!available) { finishCoverGesture(); return; }
      // 同一次拖拽的坐标基准不能跨播放器尺寸改变。
      if (coverGesture && (Math.abs(coverGesture.width - box.width) > .5 || Math.abs(coverGesture.height - box.height) > .5)) finishCoverGesture();
      Object.assign(coverLayer.style, {left: `${videoRect.left - hostRect.left - coverHost.clientLeft + coverHost.scrollLeft + box.x}px`,
        top: `${videoRect.top - hostRect.top - coverHost.clientTop + coverHost.scrollTop + box.y}px`, width: `${box.width}px`, height: `${box.height}px`});
      paintCover();
    }
    function scheduleCoverLayout() {
      if (coverLayer && !coverFrame) coverFrame = requestAnimationFrame(layoutCover);
    }
    function coverContainer(video) {
      // 双画面的小窗可能位于视频包装外；遮挡必须与整个播放器的画面层同级。
      const fullscreen = document.fullscreenElement;
      const player = video?.closest('#live-player,.live-player-mounter,.bilibili-live-player');
      if (player && (!fullscreen || fullscreen.contains(player))) return player;
      let host = video?.parentElement;
      // 绝对定位的视频可能跨过数层静态包装，不能把静态包装改成它的新定位基准。
      while (host && host !== document.body && host !== document.documentElement) {
        if (fullscreen && !fullscreen.contains(host)) return null;
        if (getComputedStyle(host).position !== 'static') return host;
        host = host.parentElement;
      }
      return video && !['absolute', 'fixed'].includes(getComputedStyle(video).position) ? video.parentElement : null;
    }
    function syncCover() {
      if (!cover.enabled || !pageActive || !room) { if (coverLayer) detachCover(); renderCoverControls(); return; }
      const fullscreen = document.fullscreenElement;
      // 优先直播播放器中的最大视频；没有视频时不创建全页遮罩。
      const videos = [...document.querySelectorAll('video,bwp-video')].filter(video => visible(video) && (!fullscreen || fullscreen.contains(video)));
      videos.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
      const video = videos.find(item => item.closest('#live-player,.live-player-mounter,.bilibili-live-player') || item.parentElement !== document.body);
      // 在播放器内部覆盖所有画面层；控制栏与菜单由独立的操作层保留。
      const host = coverContainer(video);
      if (!video || !host || host === document.body || host === document.documentElement || fullscreen === video) {
        if (coverLayer) detachCover(); renderCoverControls(); return;
      }
      if (video !== coverVideo || host !== coverHost || !coverLayer?.isConnected) attachCover(video, host);
      scheduleCoverLayout(); renderCoverControls();
    }

    // 画面风格直接处理每个媒体叶节点，不给播放器父容器加滤镜；托管图片、弹幕和按钮不参与调色。
    function normalizeStyleCurve(value) {
      const points = Array.isArray(value) ? value.slice(0, 12).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map(p => ({x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y))})).sort((a, b) => a.x - b.x) : [];
      const result = [];
      for (const p of points) if (!result.length || p.x - result.at(-1).x >= 1 / 255 - 1e-8) result.push(p);
      if (!result.length || result[0].x !== 0) result.unshift({x: 0, y: 0});
      if (result.at(-1).x !== 1) result.push({x: 1, y: 1});
      for (let i = result.length - 2; i > 0; i--) if (result[i].x < 1 / 255 || 1 - result[i].x < 1 / 255) result.splice(i, 1);
      if (result.length > 12) result.splice(11, result.length - 12);
      return result;
    }
    function normalizeStylePreset(raw) {
      const number = (key, fallback, min, max) => Number.isFinite(raw?.[key]) ? Math.max(min, Math.min(max, raw[key])) : fallback;
      return {brightness: number('brightness', 100, 0, 200), contrast: number('contrast', 100, 0, 200),
        saturation: number('saturation', 100, 0, 200), vibrance: number('vibrance', 0, -100, 100), temperature: number('temperature', 0, -100, 100),
        curves: Object.fromEntries(STYLE_CHANNELS.map(key => [key, normalizeStyleCurve(raw?.curves?.[key])]))};
    }
    function normalizeStyleSettings(raw) {
      try {
        if (typeof raw === 'string') { if (raw.length > 20000) throw Error(); raw = JSON.parse(raw); }
        const configured = raw?.configured === true;
        return {configured, enabled: configured && raw?.enabled === true, preset: normalizeStylePreset(raw?.preset)};
      } catch (_) { return {configured: false, enabled: false, preset: normalizeStylePreset(null)}; }
    }
    function readStyleSettings(id) {
      if (!id) return normalizeStyleSettings(null);
      try { if (typeof GM_getValue === 'function') { const raw = GM_getValue(STYLE_PREFIX + id, null); if (raw != null) return normalizeStyleSettings(raw); } } catch (_) {}
      try { return normalizeStyleSettings(localStorage.getItem(STYLE_PREFIX + id)); } catch (_) { return normalizeStyleSettings(null); }
    }
    function writeStyleSettings(value, id = room) {
      if (!id) return false;
      const raw = JSON.stringify(normalizeStyleSettings(value)); let saved = false;
      try { if (typeof GM_setValue === 'function') { GM_setValue(STYLE_PREFIX + id, raw); saved = true; } } catch (_) {}
      try { localStorage.setItem(STYLE_PREFIX + id, raw); saved = true; } catch (_) {}
      return saved;
    }
    function acceptStyleSettings(value) {
      const next = normalizeStyleSettings(value);
      if (JSON.stringify(next) === JSON.stringify(styleSettings)) return;
      closeStyleEditor(false); styleSettings = next; syncStyle();
    }
    function watchStyleRoom() {
      if (!room || watchedStyleRooms.has(room) || typeof GM_addValueChangeListener !== 'function') return;
      const id = room; watchedStyleRooms.add(id);
      GM_addValueChangeListener(STYLE_PREFIX + id, (_key, _old, value, remote) => { if (remote && room === id) acceptStyleSettings(value); });
    }
    function sampleStyleCurve(points, x) {
      if (x <= 0) return points[0].y;
      if (x >= 1) return points.at(-1).y;
      const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
      const tangent = i => {
        if (i === 0) return slopes[0];
        if (i === points.length - 1) return slopes.at(-1);
        const a = slopes[i - 1], b = slopes[i]; if (a * b <= 0) return 0;
        const h0 = points[i].x - points[i - 1].x, h1 = points[i + 1].x - points[i].x;
        const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
        return (w0 + w1) / (w0 / a + w1 / b);
      };
      const i = points.findIndex(p => p.x >= x) - 1, a = points[i], b = points[i + 1], h = b.x - a.x, t = (x - a.x) / h;
      const y = (2*t*t*t - 3*t*t + 1)*a.y + (t*t*t - 2*t*t + t)*h*tangent(i)
        + (-2*t*t*t + 3*t*t)*b.y + (t*t*t - t*t)*h*tangent(i + 1);
      return Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), y));
    }
    function styleTables(preset) {
      return ['r', 'g', 'b'].map(channel => Array.from({length: 256}, (_, i) => {
        let x = ((i / 255 - .5) * preset.contrast / 100 + .5) * preset.brightness / 100;
        x *= channel === 'r' ? 1 + preset.temperature * .002 : channel === 'b' ? 1 - preset.temperature * .002 : 1;
        x = Math.max(0, Math.min(1, x));
        return sampleStyleCurve(preset.curves[channel], sampleStyleCurve(preset.curves.rgb, x));
      }));
    }
    function styleSvgNode(name, attributes = {}) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    }
    function buildStyleFilter(model, vibrant) {
      model.node.replaceChildren(); model.vibrant = vibrant;
      const tone = styleSvgNode('feComponentTransfer', {in: 'SourceGraphic', result: 'tone'});
      model.channels = ['R', 'G', 'B'].map(c => { const f = styleSvgNode('feFunc' + c, {type: 'table'}); tone.appendChild(f); return f; });
      model.saturation = styleSvgNode('feColorMatrix', {in: 'tone', type: 'saturate', result: 'color'});
      model.node.append(tone, model.saturation);
      if (!vibrant) return;
      // 用色彩与灰度之差控制混合量：增加鲜艳度时保护高饱和区域，降低时优先处理鲜艳区域。
      model.gray = styleSvgNode('feColorMatrix', {in: 'color', type: 'saturate', values: 0, result: 'gray'});
      const chroma = styleSvgNode('feBlend', {in: 'color', in2: 'gray', mode: 'difference', result: 'chroma'});
      model.mask = styleSvgNode('feColorMatrix', {in: 'chroma', type: 'matrix', result: 'mask'});
      model.vibrance = styleSvgNode('feColorMatrix', {in: 'color', type: 'saturate', result: 'vibrant'});
      const changed = styleSvgNode('feComposite', {in: 'vibrant', in2: 'mask', operator: 'in', result: 'changed'});
      const retained = styleSvgNode('feComposite', {in: 'color', in2: 'mask', operator: 'out', result: 'retained'});
      const mixed = styleSvgNode('feComposite', {in: 'changed', in2: 'retained', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0});
      model.node.append(model.gray, chroma, model.mask, model.vibrance, changed, retained, mixed);
    }
    function ensureStyleFilters() {
      if (styleSvg?.isConnected) return;
      styleSvg = styleSvgNode('svg', {'aria-hidden': 'true', width: 0, height: 0});
      styleSvg.id = 'bcp-live-style-defs'; styleSvg.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;overflow:hidden';
      const defs = styleSvgNode('defs'); styleSvg.appendChild(defs);
      styleFilters = ['live', 'preview'].map(name => {
        const id = 'bcp-live-style-' + name, node = styleSvgNode('filter', {id, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB'});
        defs.appendChild(node); return {id, node, key: '', vibrant: null};
      });
      document.body.appendChild(styleSvg);
    }
    function updateStyleFilter(model, preset) {
      const key = JSON.stringify(preset); if (key === model.key) return;
      const vibrant = preset.vibrance !== 0;
      if (model.vibrant !== vibrant) buildStyleFilter(model, vibrant);
      styleTables(preset).forEach((values, i) => model.channels[i].setAttribute('tableValues', values.map(v => v.toFixed(6)).join(' ')));
      model.saturation.setAttribute('values', String(preset.saturation / 100));
      if (vibrant) {
        const sign = preset.vibrance > 0 ? -2 : 2, offset = preset.vibrance > 0 ? 1 : 0;
        model.mask.setAttribute('values', `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${sign} ${sign} ${sign} 0 ${offset}`);
        model.vibrance.setAttribute('values', String(1 + preset.vibrance / 100));
      }
      model.key = key;
    }
    function findStylePlayer() {
      const videos = [...document.querySelectorAll('video,bwp-video')].filter(visible);
      videos.sort((a, b) => b.getBoundingClientRect().width*b.getBoundingClientRect().height - a.getBoundingClientRect().width*a.getBoundingClientRect().height);
      const video = videos.find(v => v.closest('#live-player,.live-player-mounter,.bilibili-live-player')) || videos[0];
      return video ? coverContainer(video) : document.querySelector('#live-player,.live-player-mounter,.bilibili-live-player');
    }
    function styleMediaIn(host) {
      if (!host || host === document.body || host === document.documentElement) return [];
      return [...host.querySelectorAll('video,canvas,bwp-video')].filter(node =>
        !node.closest('#bcp-live-cover-layer,#bcp-live-style-dialog,.web-player-controller-wrap,.web-player-danmaku,.danmaku-menu,[role="menu"]') &&
        !(node.localName === 'bwp-video' && node.querySelector('video,canvas')));
    }
    function restoreStyleTarget(node, record) {
      if (node.style.getPropertyValue('filter') === record.applied) {
        if (record.value) node.style.setProperty('filter', record.value, record.priority); else node.style.removeProperty('filter');
      }
      node.removeAttribute('data-bcp-style-media'); styleTargets.delete(node);
    }
    function restoreStyleTargets() { for (const [node, record] of styleTargets) restoreStyleTarget(node, record); }
    function syncStyleTargets(nodes, effect) {
      const wanted = new Set(nodes);
      for (const [node, record] of styleTargets) if (!wanted.has(node) || !node.isConnected) restoreStyleTarget(node, record);
      for (const node of nodes) {
        let record = styleTargets.get(node);
        if (!record || node.style.getPropertyValue('filter') !== record.applied) {
          const value = node.style.getPropertyValue('filter'), priority = node.style.getPropertyPriority('filter');
          const computed = getComputedStyle(node).filter;
          record = {value, priority, base: computed && computed !== 'none' ? computed : '', applied: ''}; styleTargets.set(node, record);
        }
        const next = `${record.base ? record.base + ' ' : ''}${effect}`;
        if (node.style.getPropertyValue('filter') !== next || node.style.getPropertyPriority('filter') !== 'important') node.style.setProperty('filter', next, 'important');
        record.applied = node.style.getPropertyValue('filter'); node.setAttribute('data-bcp-style-media', '');
      }
    }
    function syncStyle() {
      if (!pageActive || !room || !styleSettings.enabled) { restoreStyleTargets(); renderStyleControls(); return; }
      const nodes = styleMediaIn(findStylePlayer());
      if (nodes.length) {
        ensureStyleFilters(); updateStyleFilter(styleFilters[0], styleEditor?.preset || styleSettings.preset);
        syncStyleTargets(nodes, `url("#${styleFilters[0].id}")`);
      } else restoreStyleTargets();
      renderStyleControls();
    }
    function renderStyleControls() {
      if (!panel) return;
      const toggle = panel.querySelector('[data-bcp-style-toggle]'); if (!toggle) return;
      toggle.setAttribute('aria-checked', String(styleSettings.enabled)); setText(toggle.querySelector('.bcp-switch-word'), styleSettings.enabled ? '开' : '关');
      setText(panel.querySelector('[data-bcp-style-state]'), !styleSettings.configured ? '先设置预设样式 · 每个直播间单独保存'
        : styleSettings.enabled ? styleTargets.size ? '已开启 · 主画面和独立摄像头同步调整' : '已开启 · 等待直播画面' : '预设已保存 · 当前关闭');
      if (!panel.hidden) positionPanel();
    }
    function scheduleStylePaint() {
      if (!styleEditor || stylePaintFrame) return;
      stylePaintFrame = requestAnimationFrame(() => {
        stylePaintFrame = 0; if (!styleEditor) return;
        updateStyleFilter(styleFilters[1], styleEditor.preset);
        styleDialog.querySelector('[data-bcp-style-preview]').style.filter = styleEditor.compare ? 'none' : `url("#${styleFilters[1].id}")`;
        paintStyleCurve(); syncStyle();
      });
    }
    function stylePaintOrder(node, root) {
      const key = [];
      for (let p = node; p && p !== root; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.zIndex !== 'auto' && s.position !== 'static') key.unshift(parseInt(s.zIndex, 10) || 0);
        else if (s.transform !== 'none' || Number(s.opacity) < 1 || s.isolation === 'isolate') key.unshift(0);
      }
      return key;
    }
    function takeStyleFrame() {
      if (!styleEditor || styleEditor.room !== room) return;
      const root = findStylePlayer(), output = styleDialog.querySelector('[data-bcp-style-preview]'), status = styleDialog.querySelector('[data-bcp-style-preview-state]');
      const rect = root?.getBoundingClientRect();
      if (!rect?.width || !rect.height) { setText(status, '等待直播画面，稍后可重新取帧。'); return; }
      const scale = Math.min(1, 960 / rect.width, 540 / rect.height), width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
      if (output.width !== width || output.height !== height) { output.width = width; output.height = height; }
      const ctx = output.getContext('2d'); ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, width, height);
      let drawn = 0, missed = 0;
      const nodes = styleMediaIn(root).map((node, i) => ({node, i, key: stylePaintOrder(node, root)}));
      nodes.sort((a, b) => { for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) { const n = (a.key[i] || 0) - (b.key[i] || 0); if (n) return n; } return a.i - b.i; });
      for (const {node} of nodes) {
        const r = node.getBoundingClientRect(), s = getComputedStyle(node);
        if (!r.width || !r.height || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
        const w = node.videoWidth || node.width, h = node.videoHeight || node.height;
        if (!w || !h || !['video', 'canvas'].includes(node.localName)) { missed++; continue; }
        try {
          ctx.save(); ctx.globalAlpha = Number(s.opacity) || 1;
          ctx.beginPath(); ctx.rect((r.left - rect.left)*scale, (r.top - rect.top)*scale, r.width*scale, r.height*scale); ctx.clip();
          const base = styleTargets.get(node)?.base ?? (s.filter !== 'none' ? s.filter : 'none'); ctx.filter = base || 'none';
          let box = coverPictureBox(r.width, r.height, w, h, s.objectFit, s.objectPosition);
          if (s.objectFit === 'cover') {
            const factor = Math.max(r.width / w, r.height / h), parts = s.objectPosition.split(/\s+/);
            const offset = (part, gap) => part === 'right' || part === 'bottom' ? gap : part === 'left' || part === 'top' ? 0 : gap * (Number.isFinite(parseFloat(part)) ? parseFloat(part) : 50) / 100;
            box = {x: offset(parts[0], r.width - w*factor), y: offset(parts[1], r.height - h*factor), width: w*factor, height: h*factor};
          }
          ctx.drawImage(node, (r.left - rect.left + box.x)*scale, (r.top - rect.top + box.y)*scale, box.width*scale, box.height*scale); drawn++;
        } catch (_) { missed++; } finally { ctx.restore(); }
      }
      // 只把当前帧留在内存中的 canvas，不读取像素、不导出、不上传，跨域视频也无需申请截图权限。
      setText(status, !drawn ? '当前帧暂不可取样。开启后仍可直接在直播画面中查看效果。' : missed ? '已选取当前画面 · 部分媒体暂不可取样' : styleEditor.realtime ? '实时预览 · 不包含托管图片和弹幕' : '当前帧预览 · 不包含托管图片和弹幕');
    }
    function startStylePreview() {
      if (stylePreviewFrame) return;
      let last = 0;
      const tick = now => {
        stylePreviewFrame = 0;
        if (!styleEditor || !styleEditor.realtime) return;
        if (!document.hidden && now - last >= 250) { last = now; takeStyleFrame(); }
        stylePreviewFrame = requestAnimationFrame(tick);
      };
      stylePreviewFrame = requestAnimationFrame(tick);
    }
    function paintStyleCurve() {
      if (!styleEditor) return;
      const {channel, preset, selected} = styleEditor, points = preset.curves[channel], svg = styleDialog.querySelector('[data-bcp-style-curve]');
      const color = {rgb: '#51616f', r: '#d85b62', g: '#31966c', b: '#397ed5'}[channel];
      const path = Array.from({length: 129}, (_, i) => `${i ? 'L' : 'M'}${24 + i / 128 * 240},${252 - sampleStyleCurve(points, i / 128) * 240}`).join(' ');
      svg.querySelector('[data-bcp-curve-path]').setAttribute('d', path); svg.querySelector('[data-bcp-curve-path]').setAttribute('stroke', color);
      const handles = svg.querySelector('[data-bcp-curve-handles]'); handles.replaceChildren();
      points.forEach((p, i) => { handles.appendChild(styleSvgNode('circle', {cx: 24+p.x*240, cy: 252-p.y*240, r: i === selected ? 6 : 4.5, fill: i === selected ? color : '#fff', stroke: color, 'stroke-width': 2, 'data-bcp-curve-point': i})); });
      for (const b of styleDialog.querySelectorAll('[data-bcp-style-channel]')) b.setAttribute('aria-pressed', String(b.dataset.bcpStyleChannel === channel));
      const point = points[Math.max(0, Math.min(points.length - 1, selected))];
      styleDialog.querySelector('[data-bcp-curve-x]').value = String(Math.round(point.x * 255));
      styleDialog.querySelector('[data-bcp-curve-y]').value = String(Math.round(point.y * 255));
      styleDialog.querySelector('[data-bcp-curve-x]').disabled = selected === 0 || selected === points.length - 1;
      styleDialog.querySelector('[data-bcp-curve-delete]').disabled = selected === 0 || selected === points.length - 1;
    }
    function changeStylePoint(x, y) {
      if (!styleEditor) return;
      const points = styleEditor.preset.curves[styleEditor.channel], i = styleEditor.selected;
      if (!points[i]) return;
      points[i] = {x: i === 0 ? 0 : i === points.length - 1 ? 1 : Math.max(points[i - 1].x + 1/255, Math.min(points[i + 1].x - 1/255, x)), y: Math.max(0, Math.min(1, y))};
      scheduleStylePaint();
    }
    function closeStyleEditor(save) {
      if (!styleEditor) return;
      const editor = styleEditor;
      if (save && editor.room === room) {
        const next = {configured: true, enabled: editor.enableOnSave || styleSettings.enabled, preset: normalizeStylePreset(editor.preset)};
        if (!writeStyleSettings(next)) { setText(styleDialog.querySelector('[data-bcp-style-preview-state]'), '预设无法保存，请检查脚本管理器的存储权限。'); return; }
        styleSettings = next;
      }
      styleEditor = null;
      if (stylePaintFrame) cancelAnimationFrame(stylePaintFrame); stylePaintFrame = 0;
      if (stylePreviewFrame) cancelAnimationFrame(stylePreviewFrame); stylePreviewFrame = 0;
      styleDialog?.close(); styleDialog?.remove(); styleDialog = null;
      syncStyle();
    }
    function openStyleEditor(enableOnSave) {
      if (checkRoom() || !room || !document.body) return;
      if (styleEditor) { styleDialog.focus(); return; }
      closePanel(); ensureStyleFilters();
      styleEditor = {room, preset: normalizeStylePreset(styleSettings.preset), channel: 'rgb', selected: 0, realtime: false, compare: false, enableOnSave};
      styleDialog = document.createElement('dialog'); styleDialog.id = 'bcp-live-style-dialog'; styleDialog.setAttribute('aria-labelledby', 'bcp-style-title');
      if (panel?.classList.contains('bcp-live-dark')) styleDialog.classList.add('bcp-style-dark');
      styleDialog.innerHTML = `<header><div><h2 id="bcp-style-title">预设画面风格</h2><p data-bcp-style-room></p></div><button type="button" data-bcp-style-close aria-label="关闭画面风格设置">×</button></header>
        <div class="bcp-style-body"><section class="bcp-style-preview-pane"><div class="bcp-style-preview-stage"><canvas data-bcp-style-preview width="960" height="540" aria-label="画面风格预览"></canvas></div><div class="bcp-style-preview-tools"><button type="button" data-bcp-style-capture>选取当前画面</button><button type="button" data-bcp-style-compare>按住看原画</button><label><input type="checkbox" data-bcp-style-realtime>实时画面</label></div><p data-bcp-style-preview-state role="status">正在选取当前画面…</p><p class="bcp-style-note">仅调整直播画面，托管图片与播放器按钮保持原样。</p></section>
        <section class="bcp-style-adjustments" aria-label="调色参数"><div data-bcp-style-sliders></div><div class="bcp-style-curve-header"><strong>曲线</strong><div data-bcp-style-channels></div></div><svg data-bcp-style-curve viewBox="0 0 280 280" role="group" aria-label="调色曲线，点击添加控制点，拖动调整" tabindex="0"><path d="M24 12V252H264 M24 12H264V252 M84 12V252 M144 12V252 M204 12V252 M24 72H264 M24 132H264 M24 192H264" fill="none" stroke="#dce1e5"/><path d="M24 252L264 12" stroke="#c4cdd3" stroke-dasharray="4 4"/><path data-bcp-curve-path fill="none" stroke-width="2.5"/><g data-bcp-curve-handles></g><text x="24" y="274">暗部</text><text x="237" y="274">亮部</text></svg><div class="bcp-style-point-controls"><label>输入<input type="number" min="0" max="255" step="1" data-bcp-curve-x aria-label="曲线控制点输入值"></label><label>输出<input type="number" min="0" max="255" step="1" data-bcp-curve-y aria-label="曲线控制点输出值"></label><button type="button" data-bcp-curve-delete>删除控制点</button><button type="button" data-bcp-curve-reset>复位曲线</button></div></section></div>
        <footer><button type="button" data-bcp-style-reset>全部复位</button><span></span><button type="button" data-bcp-style-cancel>取消</button><button type="button" data-bcp-style-save></button></footer>`;
      setText(styleDialog.querySelector('[data-bcp-style-room]'), `直播间 ${room} · 预设仅保存在本地`);
      setText(styleDialog.querySelector('[data-bcp-style-save]'), enableOnSave ? '保存并开启' : '保存预设');
      for (const [key, label, min, max, unit] of [['brightness', '亮度', 0, 200, '%'], ['contrast', '对比度', 0, 200, '%'], ['saturation', '饱和度', 0, 200, '%'], ['vibrance', '鲜艳度', -100, 100, ''], ['temperature', '色温', -100, 100, '']]) {
        const row = document.createElement('label'); row.className = 'bcp-style-slider';
        row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="1" aria-label="${label}" data-bcp-style-value="${key}"><output></output>`;
        const input = row.querySelector('input'), output = row.querySelector('output'); input.value = String(styleEditor.preset[key]); setText(output, input.value + unit);
        input.addEventListener('input', () => { if (!styleEditor) return; styleEditor.preset[key] = Number(input.value); setText(output, input.value + unit); scheduleStylePaint(); });
        styleDialog.querySelector('[data-bcp-style-sliders]').appendChild(row);
      }
      for (const [channel, label] of [['rgb', 'RGB'], ['r', '红'], ['g', '绿'], ['b', '蓝']]) {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.bcpStyleChannel = channel; b.textContent = label;
        b.addEventListener('click', () => { styleEditor.channel = channel; styleEditor.selected = 0; paintStyleCurve(); }); styleDialog.querySelector('[data-bcp-style-channels]').appendChild(b);
      }
      const curve = styleDialog.querySelector('[data-bcp-style-curve]'); let pointer = null;
      const pointFromEvent = event => { const r = curve.getBoundingClientRect(); return {x: Math.max(0, Math.min(1, ((event.clientX-r.left)/r.width*280-24)/240)), y: Math.max(0, Math.min(1, (252-(event.clientY-r.top)/r.height*280)/240))}; };
      curve.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !styleEditor) return; event.preventDefault();
        const p = pointFromEvent(event), points = styleEditor.preset.curves[styleEditor.channel];
        const nearest = points.map((point, i) => ({i, distance: Math.hypot(point.x-p.x, point.y-p.y)})).sort((a, b) => a.distance-b.distance)[0];
        if (nearest.distance < .05) styleEditor.selected = nearest.i;
        else {
          if (points.length >= 12 || points.some(point => Math.abs(point.x-p.x) < 1/255)) return;
          const i = points.findIndex(point => point.x > p.x); points.splice(i, 0, p); styleEditor.selected = i;
        }
        pointer = event.pointerId; curve.setPointerCapture(pointer); curve.focus(); scheduleStylePaint();
      });
      curve.addEventListener('pointermove', event => { if (event.pointerId !== pointer || !styleEditor) return; event.preventDefault(); const p = pointFromEvent(event); changeStylePoint(p.x, p.y); });
      const releasePoint = () => { if (pointer !== null && curve.hasPointerCapture(pointer)) curve.releasePointerCapture(pointer); pointer = null; };
      curve.addEventListener('pointerup', releasePoint); curve.addEventListener('pointercancel', releasePoint); curve.addEventListener('lostpointercapture', () => { pointer = null; });
      const removePoint = () => { const points = styleEditor.preset.curves[styleEditor.channel], i = styleEditor.selected; if (i > 0 && i < points.length-1) { points.splice(i, 1); styleEditor.selected = Math.max(0, i-1); scheduleStylePaint(); } };
      curve.addEventListener('keydown', event => {
        if (!styleEditor) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removePoint(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const p = styleEditor.preset.curves[styleEditor.channel][styleEditor.selected], step = (event.shiftKey ? 10 : 1)/255;
        changeStylePoint(p.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), p.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
      });
      for (const axis of ['x', 'y']) styleDialog.querySelector('[data-bcp-curve-'+axis+']').addEventListener('input', event => {
        if (!styleEditor || event.target.value === '') return;
        const p = styleEditor.preset.curves[styleEditor.channel][styleEditor.selected], value = Number(event.target.value)/255;
        if (Number.isFinite(value)) changeStylePoint(axis === 'x' ? value : p.x, axis === 'y' ? value : p.y);
      });
      styleDialog.querySelector('[data-bcp-curve-delete]').addEventListener('click', removePoint);
      styleDialog.querySelector('[data-bcp-curve-reset]').addEventListener('click', () => { styleEditor.preset.curves[styleEditor.channel] = normalizeStyleCurve(null); styleEditor.selected = 0; scheduleStylePaint(); });
      styleDialog.querySelector('[data-bcp-style-reset]').addEventListener('click', () => {
        styleEditor.preset = normalizeStylePreset(null); styleEditor.selected = 0;
        for (const input of styleDialog.querySelectorAll('[data-bcp-style-value]')) { input.value = String(styleEditor.preset[input.dataset.bcpStyleValue]); input.dispatchEvent(new Event('input', {bubbles: true})); }
        scheduleStylePaint();
      });
      const compare = styleDialog.querySelector('[data-bcp-style-compare]');
      const comparison = value => { if (styleEditor) { styleEditor.compare = value; scheduleStylePaint(); } };
      compare.addEventListener('pointerdown', event => { event.preventDefault(); compare.setPointerCapture(event.pointerId); comparison(true); });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) compare.addEventListener(type, () => comparison(false));
      compare.addEventListener('keydown', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); comparison(true); } });
      compare.addEventListener('keyup', () => comparison(false)); compare.addEventListener('blur', () => comparison(false));
      styleDialog.querySelector('[data-bcp-style-capture]').addEventListener('click', takeStyleFrame);
      styleDialog.querySelector('[data-bcp-style-realtime]').addEventListener('change', event => {
        styleEditor.realtime = event.target.checked;
        if (styleEditor.realtime) startStylePreview(); else { if (stylePreviewFrame) cancelAnimationFrame(stylePreviewFrame); stylePreviewFrame = 0; takeStyleFrame(); }
      });
      for (const selector of ['[data-bcp-style-close]', '[data-bcp-style-cancel]']) styleDialog.querySelector(selector).addEventListener('click', () => closeStyleEditor(false));
      styleDialog.querySelector('[data-bcp-style-save]').addEventListener('click', () => closeStyleEditor(true));
      styleDialog.addEventListener('cancel', event => { event.preventDefault(); closeStyleEditor(false); });
      // 不使用背景 click 关闭，曲线拖拽到弹窗外松手不会误取消设置。
      const fullscreen = document.fullscreenElement;
      (fullscreen && !['VIDEO', 'BWP-VIDEO'].includes(fullscreen.tagName) ? fullscreen : document.body).appendChild(styleDialog);
      styleDialog.showModal(); paintStyleCurve(); scheduleStylePaint();
      requestAnimationFrame(() => { if (styleEditor) takeStyleFrame(); });
    }

    function roomId() { return location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/)?.[1] || ''; }
    function storageKey(id = room) { return STORAGE_PREFIX + id; }
    function validUid(uid) { return /^[1-9]\d*$/.test(uid || ''); }
    function ownUid() { return document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)(?:;|$)/)?.[1] || ''; }
    function normalizeSettings(raw) {
      try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // 兼容旧版仅有 target 的房间设置；空数组表示明确取消全部对象。
        const people = Array.isArray(value?.targets) ? value.targets : value?.target ? [value.target] : [];
        const targets = [];
        for (const person of people) {
          const uid = String(person?.uid || '');
          if (!validUid(uid) || targets.some(item => item.uid === uid)) continue;
          targets.push({uid, name: String(person.name || `用户 ${uid}`).slice(0, 120)});
          if (targets.length === MAX_TARGETS) break;
        }
        return {targets, random: targets.length === 0 && value?.random === true, disabled: value?.disabled === true};
      } catch (_) { return {targets: [], random: false, disabled: false}; }
    }

    function readSettings(id) {
      if (!id) return normalizeSettings(null);
      try {
        if (typeof GM_getValue === 'function') {
          const value = GM_getValue(storageKey(id), null);
          if (value != null) return normalizeSettings(value);
        }
      } catch (_) {}
      try { return normalizeSettings(localStorage.getItem(storageKey(id))); }
      catch (_) { return normalizeSettings(null); }
    }
    function saveSettings() {
      if (!room) return;
      const value = JSON.stringify(settings);
      let saved = false;
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(storageKey(), value); saved = true; }
      } catch (_) {}
      try { localStorage.setItem(storageKey(), value); saved = true; } catch (_) {}
      if (!saved) tell('设置暂时无法保存，刷新后可能丢失。');
    }
    function watchRoom() {
      if (!room || watchedRooms.has(room) || typeof GM_addValueChangeListener !== 'function') return;
      watchedRooms.add(room);
      const id = room;
      GM_addValueChangeListener(storageKey(id), (_name, _old, value, remote) => {
        if (remote && room === id) acceptSettings(value);
      });
    }
    function acceptSettings(value) {
      const next = normalizeSettings(value);
      if (JSON.stringify(next) === JSON.stringify(settings)) return;
      resetRuntime(); settings = next; baseline(); armRandom(); render(); queueMenu();
    }
    function changeSettings(patch, detail) {
      if (checkRoom()) return;
      resetRuntime();
      settings = normalizeSettings({...settings, ...patch});
      baseline(); saveSettings(); armRandom(); render(); queueMenu();
      if (detail) tell(detail);
    }
    function clearPending() {
      const flight = pending; pending = null;
      if (flight) { clearTimeout(flight.timer); flight.controller.abort(); }
    }
    function resetRuntime() {
      session += 1;
      clearTimeout(randomTimer); randomTimer = 0; randomReady = false; randomDue = 0;
      clearPending(); clearTimeout(queueTimer); queueTimer = 0; sendQueue.length = 0;
    }
    function effectiveRandom() {
      return pageActive && !!room && !awaitingRoom && !!chat?.isConnected &&
        settings.random && settings.targets.length === 0 && !settings.disabled;
    }
    function canSend(message, mode) {
      if (!pageActive || roomId() !== room || awaitingRoom || settings.disabled) return false;
      return mode === 'random' ? settings.random && settings.targets.length === 0 : settings.targets.some(person => person.uid === message.uid);
    }
    function armRandom() {
      if (!effectiveRandom() || randomTimer || randomReady) return;
      const version = session, delay = 6000 + Math.floor(Math.random() * 9001);
      randomDue = Date.now() + delay;
      randomTimer = setTimeout(() => {
        randomTimer = 0; randomDue = 0;
        if (version !== session || checkRoom() || !effectiveRandom()) return;
        randomReady = true; render();
      }, delay);
      render();
    }
    function checkRoom() {
      const next = roomId();
      if (next === room) return false;
      resetRuntime(); resetCover(); closeStyleEditor(false); restoreStyleTargets();
      room = next; settings = readSettings(room); styleSettings = readStyleSettings(room); candidate = null; canonicalRoom = null;
      awaitingRoom = !!chat; seen.clear(); submitted = acknowledged = 0; lastDetail = '';
      baseline(); closePanel(); watchRoom(); watchStyleRoom(); syncStyle(); render(); queueMenu();
      return true;
    }
    function visible(el) {
      return Boolean(el?.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    }
    function disabled(el) {
      return !el || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
        /(?:^|\s)(?:disabled|is-disabled|bl-button--disabled)(?:\s|$)/.test(el.className);
    }
    function controls() {
      const root = document.getElementById('control-panel-ctnr-box');
      return {
        input: [...(root?.querySelectorAll('textarea.chat-input') || [])].find(visible),
        button: [...(root?.querySelectorAll('button.send-btn') || [])].find(visible),
      };
    }
    function tell(detail) {
      lastDetail = detail; render();
      if (!feedback || !visible(toolbarButton)) return;
      feedback.textContent = detail; feedback.hidden = false; positionPanel();
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 3500);
    }
    function skip(detail) { lastDetail = `已跳过：${detail}`; render(); }
    function pause(detail) {
      changeSettings({disabled: true}, `${detail} 已开启当前直播间禁用，检查后可手动关闭禁用。`);
    }
    function readRow(row) {
      if (!row.matches(ROW)) return null;
      const uid = row.getAttribute('data-uid') || '', text = row.getAttribute('data-danmaku') || '';
      const id = row.getAttribute('data-id_str') || row.getAttribute('data-id');
      const ts = row.getAttribute('data-ts') || row.getAttribute('data-timestamp') || '';
      const emoji = row.getAttribute('data-type') === '1' || row.hasAttribute('data-image') || row.classList.contains('chat-emoticon');
      // 只移除页面明确渲染成表情的代码，保留普通的 [文字]。
      let plain = emoji ? '' : text;
      for (const image of row.querySelectorAll('.danmaku-item-right img[alt]')) {
        const token = image.getAttribute('alt');
        if (token) plain = plain.split(token).join('');
      }
      plain = plain.replace(/(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu, '')
        .replace(/[\u200D\uFE0F\uFE0E\u{E0020}-\u{E007F}]/gu, '').trim();
      return {uid, text, plain, emoji, name: row.getAttribute('data-uname') || `用户 ${uid}`,
        key: id ? `${uid}:id:${id}` : `${uid}:fallback:${ts}:${text}`};
    }
    function remember(message) {
      if (seen.has(message.key)) return false;
      seen.set(message.key, true);
      if (seen.size > 1500) seen.delete(seen.keys().next().value);
      return true;
    }
    function baseline() {
      chatObserver?.takeRecords();
      for (const row of chat?.querySelectorAll(ROW) || []) { const message = readRow(row); if (message) remember(message); }
    }
    function begin(person) {
      if (checkRoom() || awaitingRoom) return tell('直播间正在切换，请稍后重新选择。');
      if (!person || !validUid(person.uid)) return tell('无法识别 UID，请登录后刷新直播间。');
      if (person.uid === ownUid()) return tell('不能跟随自己。');
      if (settings.targets.some(item => item.uid === person.uid)) return tell('已在跟车列表中。');
      if (settings.targets.length >= MAX_TARGETS) return tell('最多同时跟车 3 人，请先取消一位再添加。');
      changeSettings({targets: [...settings.targets, {uid: person.uid, name: person.name}], random: false},
        settings.disabled ? '已保存跟车对象；当前直播间仍处于禁用状态。' : `已添加跟车对象（${settings.targets.length + 1}/3），等待新的文字弹幕。`);
    }
    function removeTarget(uid) {
      changeSettings({targets: settings.targets.filter(person => person.uid !== uid)}, '已取消此用户的跟车，其他对象保持不变。');
    }
    function enqueueFollow(message, mode) {
      if (checkRoom() || !canSend(message, mode)) return;
      const text = mode === 'random' ? message.plain : message.text;
      if (message.emoji || !text.trim()) return skip('表情或空内容。');
      if (sendQueue.some(item => item.text === text) || pending?.text === text) return skip('相同内容已在等待发送。');
      if (sendQueue.length >= MAX_QUEUE) return skip('等待列表已满，本条不再排队。');
      sendQueue.push({message, mode, text, at: Date.now()}); scheduleQueue();
    }
    function scheduleQueue() {
      if (pending || queueTimer || !sendQueue.length) return;
      queueTimer = setTimeout(() => {
        queueTimer = 0;
        while (sendQueue.length) {
          const item = sendQueue.shift();
          if (Date.now() - item.at > MAX_QUEUE_AGE || !canSend(item.message, item.mode)) continue;
          void repeat(item.message, item.mode); break;
        }
      }, Math.max(0, lastSentAt + MIN_INTERVAL - Date.now()));
    }
    async function resolveRoom(signal) {
      if (canonicalRoom?.source === room) return canonicalRoom.id;
      const source = room;
      const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(source)}`, {credentials: 'omit', signal});
      if (!response.ok) throw new Error('无法确认当前直播间。');
      const result = await response.json();
      const id = String(result?.data?.room_id || '');
      if (result?.code !== 0 || !validUid(id)) throw new Error('无法确认当前直播间。');
      if (source === room) canonicalRoom = {source, id};
      return id;
    }
    async function repeat(message, mode) {
      try { await sendRepeat(message, mode); }
      finally { scheduleQueue(); }
    }
    async function sendRepeat(message, mode) {
      if (checkRoom() || !canSend(message, mode) || pending) return;
      if (!validUid(ownUid())) return pause('登录状态不可用。');
      if (message.uid === ownUid()) return;
      const text = mode === 'random' ? message.plain : message.text;
      if (message.emoji || !text.trim()) return skip('表情或空内容。');
      const now = Date.now();
      for (const [key, at] of recentTexts) if (now - at >= REPEAT_WINDOW) recentTexts.delete(key);
      const repeatKey = `${room}:${text}`;
      if (recentTexts.has(repeatKey)) return skip('15 秒内已跟发过相同内容。');
      const {input} = controls();
      if (!input) return skip('弹幕发送控件尚不可用。');
      if (disabled(input) || input.readOnly) return skip('网页暂不允许发送。');
      if (input.maxLength > 0 && text.length > input.maxLength) return skip('内容超过输入框字数限制。');
      const csrf = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)(?:;|$)/)?.[1] || '';
      if (!csrf) return pause('登录校验不可用，请重新登录直播间。');
      // 独立请求不触碰网页输入框：草稿、选区、焦点和中文输入法状态均保持原样。
      const version = session, flight = {text, timer: 0, clicked: false, controller: new AbortController()};
      pending = flight;
      flight.timer = setTimeout(() => {
        if (pending === flight) pause('发送或回显确认超过 8 秒，不自动重试。');
      }, ACK_TIMEOUT);
      try {
        const id = await resolveRoom(flight.controller.signal);
        if (version !== session || pending !== flight || !canSend(message, mode)) {
          if (pending === flight) clearPending(); return;
        }
        const body = new URLSearchParams({bubble: '0', msg: text, color: '16777215', mode: '1', fontsize: '25',
          rnd: String(Math.floor(Date.now() / 1000)), roomid: id, csrf, csrf_token: csrf});
        lastSentAt = Date.now(); recentTexts.set(repeatKey, lastSentAt); submitted += 1; flight.clicked = true;
        const response = await fetch('https://api.live.bilibili.com/msg/send', {
          method: 'POST', credentials: 'include', body, signal: flight.controller.signal,
        });
        if (version !== session || pending !== flight) return;
        if (!response.ok) throw new Error(`发送请求失败（HTTP ${response.status}）。`);
        const result = await response.json();
        if (version !== session || pending !== flight) return;
        if (result?.code !== 0) throw new Error(String(result?.message || result?.msg || '网页拒绝了本次发送。').slice(0, 120));
        lastDetail = '已提交，等待本人的弹幕回显。'; render();
      } catch (problem) {
        if (version !== session || pending !== flight) return;
        pause(`自动发送未完成：${problem instanceof Error ? problem.message : '网络或权限异常。'}`);
      }
    }

    function processRow(row) {
      const message = readRow(row);
      if (!message || !remember(message)) return;
      if (pending?.clicked && message.uid === ownUid() && message.text === pending.text) {
        clearPending(); acknowledged += 1; lastDetail = '已看到本人的弹幕回显。'; render(); scheduleQueue();
      }
      if (settings.disabled || awaitingRoom || !validUid(message.uid) || message.uid === ownUid()) return;
      if (settings.targets.length) {
        if (settings.targets.some(person => person.uid === message.uid)) enqueueFollow(message, 'target');
      } else if (effectiveRandom() && randomReady) {
        // 一次到点只消费下一条他人弹幕；跳过或失败也不积压。
        randomReady = false; enqueueFollow(message, 'random'); armRandom();
      }
    }
    function bindChat() {
      const next = document.getElementById('chat-items');
      if (next === chat) return;
      resetRuntime(); chatObserver?.disconnect(); chat = next;
      if (!chat) return;
      awaitingRoom = false;
      chatObserver = new MutationObserver(records => {
        if (checkRoom() || awaitingRoom) { baseline(); return; }
        const rows = new Set();
        for (const record of records) {
          if (record.type === 'attributes') rows.add(record.target);
          for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches(ROW)) rows.add(node);
            for (const row of node.querySelectorAll(ROW)) rows.add(row);
          }
        }
        for (const row of rows) if (chat.contains(row)) processRow(row);
      });
      baseline();
      chatObserver.observe(chat, {childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-uid', 'data-danmaku', 'data-id_str', 'data-id', 'data-ts']});
      armRandom(); render();
    }

    function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
    function render() {
      if (!panel || !toolbarButton) return;
      const people = settings.targets;
      const list = panel.querySelector('[data-bcp-people]');
      setText(panel.querySelector('[data-bcp-target-count]'), `${people.length}/3`);
      const signature = JSON.stringify(people);
      if (list.dataset.people !== signature) {
        list.dataset.people = signature; list.replaceChildren();
        if (!people.length) { const empty = document.createElement('span'); empty.className = 'bcp-live-empty'; empty.textContent = '暂无'; list.appendChild(empty); }
        for (const person of people) {
          const item = document.createElement('div'); item.className = 'bcp-live-person';
          item.title = `${person.name}（UID ${person.uid}）`;
          const identity = document.createElement('span'); identity.className = 'bcp-live-identity';
          const name = document.createElement('span'); name.setAttribute('data-bcp-person-name', ''); name.textContent = person.name;
          const uid = document.createElement('span'); uid.setAttribute('data-bcp-person-uid', ''); uid.textContent = `（UID ${person.uid}）`;
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bcp-live-clear';
          remove.setAttribute('aria-label', `取消跟车 ${person.name}`); remove.title = '取消跟车'; remove.textContent = '×';
          remove.addEventListener('click', () => removeTarget(person.uid));
          identity.append(name, uid); item.append(identity, remove); list.appendChild(item);
        }
      }
      const random = panel.querySelector('[data-bcp-random]');
      const disable = panel.querySelector('[data-bcp-disable]');
      random.disabled = people.length > 0;
      random.setAttribute('aria-checked', String(settings.random));
      random.title = people.length ? '请先取消「我来同你玩」中的对象' : '每次随机等待 6～15 秒，再跟发下一条弹幕的纯文字';
      disable.setAttribute('aria-checked', String(settings.disabled));
      setText(random.querySelector('.bcp-switch-word'), settings.random ? '开' : '关');
      setText(disable.querySelector('.bcp-switch-word'), settings.disabled ? '开' : '关');
      const mode = settings.disabled ? 'disabled' : people.length ? 'target' : settings.random ? 'random' : 'off';
      toolbarButton.dataset.mode = mode;
      panel.dataset.disabled = String(settings.disabled);
      const summary = settings.disabled ? '当前直播间已禁用跟车' : people.length ? `跟车（${people.length}/3）：${people.map(person => person.name).join('、')}`
        : settings.random ? (randomReady ? '路怒模式（随机车）：等待下一条弹幕' : '路怒模式（随机车）：等待 6～15 秒') : '跟车设置：暂无跟车对象';
      toolbarButton.title = `${summary}\n房间 ${room} · 已提交 ${submitted} / 已回显 ${acknowledged}${lastDetail ? '\n' + lastDetail : ''}`;
      renderCoverControls();
      renderStyleControls();
      if (!panel.hidden) positionPanel();
    }
    function closePanel() {
      if (panel) panel.hidden = true;
      toolbarButton?.setAttribute('aria-expanded', 'false');
    }
    function positionPanel() {
      if (!visible(toolbarButton) || !panel) { closePanel(); if (feedback) feedback.hidden = true; return; }
      const anchor = toolbarButton.getBoundingClientRect();
      const control = document.getElementById('control-panel-ctnr-box')?.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.max(0, Math.min(400, viewportWidth - 16));
      const left = Math.max(8, Math.min((control?.right || anchor.right) - width, viewportWidth - width - 8));
      panel.style.width = `${width}px`;
      panel.style.left = `${left}px`;
      const height = panel.offsetHeight || 146;
      const top = anchor.top >= height + 16 ? anchor.top - height - 10 : anchor.bottom + 10;
      panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
      if (feedback && !feedback.hidden) {
        feedback.style.width = `${width}px`; feedback.style.left = `${left}px`;
        feedback.style.top = `${Math.max(8, (panel.hidden ? anchor.top : parseFloat(panel.style.top)) - feedback.offsetHeight - 8)}px`;
      }
    }
    function syncTheme() {
      if (!toolbarButton || !panel) return;
      let dark = false, current = document.getElementById('control-panel-ctnr-box');
      while (current) {
        const color = getComputedStyle(current).backgroundColor.match(/[\d.]+/g)?.map(Number);
        if (color?.length >= 3 && (color.length < 4 || color[3] >= .85)) {
          dark = (color[0] * .299 + color[1] * .587 + color[2] * .114) < 110; break;
        }
        current = current.parentElement;
      }
      panel.classList.toggle('bcp-live-dark', dark);
      feedback.classList.toggle('bcp-live-dark', dark);
    }
    function mountToolbar() {
      const toolbar = document.querySelector('#control-panel-ctnr-box .control-panel-icon-row .icon-left-part');
      if (!toolbar || !toolbarButton) return;
      if (toolbarButton.parentElement !== toolbar) toolbar.appendChild(toolbarButton);
      syncTheme();
    }
    function createUI() {
      const style = document.createElement('style');
      style.textContent = `
        #bcp-live-toolbar-button{display:inline-flex!important;position:relative;vertical-align:middle;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:30px;margin:0 0 0 8px;padding:2px;border:0;border-radius:5px;background:transparent;color:#c9ccd0;cursor:pointer;box-sizing:border-box;line-height:1;transition:background .15s,color .15s}
        #bcp-live-toolbar-button:hover,#bcp-live-toolbar-button[aria-expanded="true"]{background:#00aeec16;color:#00aeec}
        #bcp-live-toolbar-button svg{display:block;width:24px;height:24px;pointer-events:none}
        #bcp-live-toolbar-button:focus-visible,#bcp-live-panel button:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
        #bcp-live-toolbar-button[data-mode="target"]{color:#00aeec}
        #bcp-live-toolbar-button[data-mode="random"]{color:#8d6ce8}
        #bcp-live-toolbar-button[data-mode="disabled"]{color:#f85a7c}
        #bcp-live-toolbar-button::after{content:"";display:none;position:absolute;width:5px;height:5px;right:1px;top:1px;border-radius:50%;background:currentColor}
        #bcp-live-toolbar-button:not([data-mode="off"])::after{display:block}
        #bcp-live-panel,#bcp-live-feedback{--bcp-bg:#fff;--bcp-fg:#61666d;--bcp-sub:#9499a0;--bcp-line:#e3e5e7;position:fixed;z-index:2147483646;box-sizing:border-box;background:var(--bcp-bg);color:var(--bcp-fg);border:1px solid var(--bcp-line);border-radius:8px;box-shadow:0 4px 20px #00000024;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;text-align:left}
        #bcp-live-panel{z-index:2147483647;padding:2px 12px;max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain}
        #bcp-live-panel[hidden],#bcp-live-feedback[hidden],#bcp-live-panel [hidden]{display:none!important}
        #bcp-live-panel.bcp-live-dark,#bcp-live-feedback.bcp-live-dark{--bcp-bg:#24282f;--bcp-fg:#e3e5e7;--bcp-sub:#a0a5ad;--bcp-line:#3a4049}
        #bcp-live-panel .bcp-live-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;box-sizing:border-box;padding:8px 0}
        #bcp-live-panel .bcp-live-row+.bcp-live-row{border-top:1px solid var(--bcp-line)}
        #bcp-live-panel .bcp-live-label{white-space:nowrap;flex-shrink:0;font-weight:400}
        #bcp-live-panel .bcp-live-targets{align-items:flex-start!important}
        #bcp-live-panel .bcp-live-people{display:flex;flex:1;flex-direction:column;gap:8px;min-width:0}
        #bcp-live-panel [data-bcp-target-count],#bcp-live-panel .bcp-live-empty{font-size:11px;color:var(--bcp-sub)}
        #bcp-live-panel .bcp-live-empty{text-align:right}
        #bcp-live-panel .bcp-live-person{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex:1;min-width:0}
        #bcp-live-panel .bcp-live-identity{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;min-width:0;column-gap:1px}
        #bcp-live-panel [data-bcp-person-name]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;min-width:0;color:var(--bcp-fg)}
        #bcp-live-panel [data-bcp-person-uid]{font-size:11px;color:var(--bcp-sub);overflow-wrap:anywhere}
        #bcp-live-panel .bcp-live-clear{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:2px;border:0;border-radius:4px;background:transparent;color:#f45b79;font-size:22px;cursor:pointer;flex-shrink:0}
        #bcp-live-panel .bcp-live-clear:hover{background:#f45b7918}
        #bcp-live-panel .bcp-live-clear svg{width:14px;height:14px;pointer-events:none}
        #bcp-live-panel .bcp-live-switch{display:inline-flex;gap:7px;align-items:center;flex-shrink:0;padding:3px 0 3px 5px;border:0;background:transparent;color:var(--bcp-sub);font:inherit;cursor:pointer}
        #bcp-live-panel .bcp-switch-track{position:relative;display:inline-block;width:28px;height:16px;border-radius:9px;background:#c9ccd0;transition:background .15s}
        #bcp-live-panel .bcp-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .15s}
        #bcp-live-panel .bcp-live-switch[aria-checked="true"]{color:#00aeec}
        #bcp-live-panel .bcp-live-switch[aria-checked="true"] .bcp-switch-track{background:#00aeec}
        #bcp-live-panel .bcp-live-switch[aria-checked="true"] .bcp-switch-track::after{transform:translateX(12px)}
        #bcp-live-panel [data-bcp-disable][aria-checked="true"]{color:#f45b79}
        #bcp-live-panel [data-bcp-disable][aria-checked="true"] .bcp-switch-track{background:#f45b79}
        #bcp-live-panel .bcp-live-switch:disabled{opacity:.42;cursor:not-allowed}
        #bcp-live-panel[data-disabled="true"] .bcp-live-targets .bcp-live-label{color:var(--bcp-sub)}
        #bcp-live-panel .bcp-cover-options{border-top:1px solid var(--bcp-line);padding:12px 0;display:flex;flex-wrap:wrap;gap:9px;align-items:center}
        #bcp-live-panel .bcp-cover-colors{display:flex;gap:6px}
        #bcp-live-panel [data-bcp-cover-color]{width:26px;height:26px;padding:0;border-radius:50%;border:1px solid var(--bcp-line);background:var(--bcp-swatch);cursor:pointer;box-sizing:border-box}
        #bcp-live-panel [data-bcp-cover-color][aria-pressed="true"]{outline:2px solid #00aeec;outline-offset:2px}
        #bcp-live-panel .bcp-cover-upload{position:relative;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;padding:4px 8px;border:1px solid var(--bcp-line);border-radius:4px;background:var(--bcp-bg);color:var(--bcp-fg);font:inherit;cursor:pointer}
        #bcp-live-panel .bcp-cover-upload:focus-within{outline:2px solid #00aeec;outline-offset:2px}
        #bcp-live-panel [data-bcp-cover-file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
        #bcp-live-panel [data-bcp-cover-status],#bcp-live-panel [data-bcp-cover-filename]{margin:0;width:100%;font-size:11px;color:var(--bcp-sub);overflow-wrap:anywhere}
        #bcp-live-cover-layer{position:absolute!important;z-index:2147483646!important;overflow:hidden!important;pointer-events:none!important;box-sizing:border-box!important;isolation:isolate}
        /* 仅托管开启时保留播放器操作层；不把摄像头所在的业务画面层一起抬高。 */
        [data-bcp-cover-host]>.web-player-controller-wrap,[data-bcp-cover-host]>.web-player-video-info-panel,[data-bcp-cover-host]>.web-player-icon-feedback,[data-bcp-cover-host]>ul,[data-bcp-cover-host]>[role="menu"]{z-index:2147483647!important}
        #bcp-live-cover-layer[hidden],#bcp-live-cover img[hidden]{display:none!important}
        #bcp-live-cover{position:absolute!important;box-sizing:border-box!important;pointer-events:auto!important;touch-action:none!important;user-select:none!important;cursor:move!important;line-height:1!important}
        #bcp-live-cover>img{display:block!important;width:100%!important;height:100%!important;object-fit:fill!important;pointer-events:none!important;border:0!important;margin:0!important;padding:0!important}
        #bcp-live-cover:hover,#bcp-live-cover:focus-within,#bcp-live-cover[data-dragging]{box-shadow:inset 0 0 0 1px #00aeec}
        #bcp-live-cover:focus-visible{outline:2px solid #00aeec;outline-offset:-2px}
        #bcp-live-cover[data-locked="true"]{cursor:default!important}
        #bcp-live-cover .bcp-cover-tools{position:absolute;right:3px;top:3px;display:flex;opacity:0;transition:opacity .12s}
        #bcp-live-cover:hover .bcp-cover-tools,#bcp-live-cover:focus-within .bcp-cover-tools{opacity:1}
        #bcp-live-cover .bcp-cover-tools button{display:block;min-height:26px;min-width:28px;padding:4px;border:1px solid #ffffff66;border-radius:4px;background:#18191ccc;color:#fff;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;cursor:pointer}
        #bcp-live-cover [data-bcp-cover-handle]{position:absolute;width:12px;height:12px;border:1px solid #00aeec;background:#fff;box-sizing:border-box;opacity:0;touch-action:none}
        #bcp-live-cover:hover [data-bcp-cover-handle],#bcp-live-cover:focus-within [data-bcp-cover-handle],#bcp-live-cover[data-dragging] [data-bcp-cover-handle]{opacity:1}
        #bcp-live-cover[data-locked="true"] [data-bcp-cover-handle]{display:none!important}
        #bcp-live-cover [data-bcp-cover-handle="n"]{top:-6px;left:calc(50% - 6px);cursor:n-resize}
        #bcp-live-cover [data-bcp-cover-handle="ne"]{top:-6px;right:-6px;cursor:ne-resize}
        #bcp-live-cover [data-bcp-cover-handle="e"]{top:calc(50% - 6px);right:-6px;cursor:e-resize}
        #bcp-live-cover [data-bcp-cover-handle="se"]{bottom:-6px;right:-6px;cursor:se-resize}
        #bcp-live-cover [data-bcp-cover-handle="s"]{bottom:-6px;left:calc(50% - 6px);cursor:s-resize}
        #bcp-live-cover [data-bcp-cover-handle="sw"]{bottom:-6px;left:-6px;cursor:sw-resize}
        #bcp-live-cover [data-bcp-cover-handle="w"]{top:calc(50% - 6px);left:-6px;cursor:w-resize}
        #bcp-live-cover [data-bcp-cover-handle="nw"]{top:-6px;left:-6px;cursor:nw-resize}
        #bcp-live-panel .bcp-style-preset{margin-left:auto;padding:4px 9px;border:1px solid var(--bcp-line);border-radius:5px;background:var(--bcp-bg);color:var(--bcp-fg);font:inherit;cursor:pointer}
        #bcp-live-panel .bcp-style-state{margin:0 0 10px;font-size:11px;color:var(--bcp-sub)}
        #bcp-live-style-dialog{--bs-bg:#fff;--bs-fg:#313b45;--bs-sub:#7b8790;--bs-line:#e1e6eb;--bs-field:#f5f7f9;position:fixed;inset:0;margin:auto;width:min(920px,calc(100vw - 24px));height:max-content;max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--bs-line);border-radius:12px;box-shadow:0 18px 80px #0005;background:var(--bs-bg);color:var(--bs-fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;text-align:left}
        #bcp-live-style-dialog.bcp-style-dark{--bs-bg:#22272e;--bs-fg:#e1e8ee;--bs-sub:#a5b0b9;--bs-line:#434b54;--bs-field:#303740}
        #bcp-live-style-dialog[open]{display:flex;flex-direction:column}
        #bcp-live-style-dialog::backdrop{background:#0a152c70}
        #bcp-live-style-dialog,#bcp-live-style-dialog *{box-sizing:border-box}
        #bcp-live-style-dialog header,#bcp-live-style-dialog footer{display:flex;align-items:center;gap:10px;padding:16px 20px;flex-shrink:0}
        #bcp-live-style-dialog header{justify-content:space-between;border-bottom:1px solid var(--bs-line)}
        #bcp-live-style-dialog h2{font-size:19px;line-height:1.4;margin:0;font-weight:650;color:var(--bs-fg)}
        #bcp-live-style-dialog p{font-size:12px;line-height:1.6;color:var(--bs-sub);margin:6px 0 0}
        #bcp-live-style-dialog button{border:1px solid var(--bs-line);border-radius:5px;padding:5px 9px;background:var(--bs-bg);color:var(--bs-fg);font:inherit;cursor:pointer;white-space:nowrap}
        #bcp-live-style-dialog button:hover{background:var(--bs-field)}
        #bcp-live-style-dialog button:disabled{opacity:.4;cursor:default}
        #bcp-live-style-dialog [data-bcp-style-close]{border:0;font-size:25px;line-height:1;padding:6px}
        #bcp-live-style-dialog .bcp-style-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:22px;padding:20px;overflow:auto;overscroll-behavior:contain;min-height:0}
        #bcp-live-style-dialog section{min-width:0}
        #bcp-live-style-dialog .bcp-style-preview-pane{position:sticky;top:0;align-self:start}
        #bcp-live-style-dialog .bcp-style-preview-stage{display:grid;place-items:center;min-height:170px;background:#111;border-radius:7px;overflow:hidden}
        #bcp-live-style-dialog [data-bcp-style-preview]{display:block;width:100%;height:auto;max-height:340px;object-fit:contain}
        #bcp-live-style-dialog .bcp-style-preview-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 7px}
        #bcp-live-style-dialog .bcp-style-preview-tools label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px}
        #bcp-live-style-dialog .bcp-style-note{margin-top:12px}
        #bcp-live-style-dialog .bcp-style-slider{display:grid;grid-template-columns:52px minmax(0,1fr) 43px;gap:9px;align-items:center;margin:0 0 13px}
        #bcp-live-style-dialog input[type=range]{min-width:0;width:100%;margin:0;accent-color:#00aeec;cursor:pointer}
        #bcp-live-style-dialog output{text-align:right;font-variant-numeric:tabular-nums;color:var(--bs-sub);font-size:12px}
        #bcp-live-style-dialog .bcp-style-curve-header{display:flex;justify-content:space-between;align-items:center;margin:20px 0 6px;gap:8px}
        #bcp-live-style-dialog [data-bcp-style-channels]{display:flex;gap:4px}
        #bcp-live-style-dialog [data-bcp-style-channel]{padding:3px 8px;font-size:12px}
        #bcp-live-style-dialog [data-bcp-style-channel][aria-pressed=true]{border-color:#00aeec;background:#00aeec14;color:#0088bc}
        #bcp-live-style-dialog [data-bcp-style-curve]{display:block;max-width:280px;width:100%;margin:0 auto;background:var(--bs-field);border-radius:5px;touch-action:none;user-select:none;cursor:crosshair}
        #bcp-live-style-dialog [data-bcp-style-curve] text{fill:var(--bs-sub);font:10px sans-serif}
        #bcp-live-style-dialog [data-bcp-curve-point]{cursor:grab}
        #bcp-live-style-dialog .bcp-style-point-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;font-size:11px}
        #bcp-live-style-dialog .bcp-style-point-controls label{display:inline-flex;align-items:center;gap:4px}
        #bcp-live-style-dialog input[type=number]{width:52px;max-width:100%;border:1px solid var(--bs-line);border-radius:4px;padding:4px;background:var(--bs-bg);color:var(--bs-fg);font:inherit}
        #bcp-live-style-dialog .bcp-style-point-controls button{font-size:11px;padding:4px 6px}
        #bcp-live-style-dialog footer{border-top:1px solid var(--bs-line)}
        #bcp-live-style-dialog footer>span{flex:1}
        #bcp-live-style-dialog [data-bcp-style-save]{background:#00aeec;border-color:#00aeec;color:#fff;padding-left:15px;padding-right:15px}
        #bcp-live-style-dialog button:focus-visible,#bcp-live-style-dialog input:focus-visible,#bcp-live-style-dialog svg:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
        @media(max-width:640px){#bcp-live-style-dialog .bcp-style-body{grid-template-columns:minmax(0,1fr);gap:18px;padding:14px}#bcp-live-style-dialog .bcp-style-preview-pane{position:static}#bcp-live-style-dialog header,#bcp-live-style-dialog footer{padding:12px 14px}#bcp-live-style-dialog .bcp-style-preview-stage{min-height:130px}#bcp-live-style-dialog h2{font-size:17px}}
        @media(hover:none){#bcp-live-cover .bcp-cover-tools,#bcp-live-cover [data-bcp-cover-handle]{opacity:1}}
        #bcp-live-feedback{padding:9px 12px;font-size:12px;z-index:2147483647;pointer-events:none}
        .danmaku-menu [data-bcp-live-follow]{display:block;width:100%;box-sizing:border-box;text-align:left;padding:11px 12px;border:0;border-top:1px solid #e3e5e7;background:transparent;color:#00aeec;font:inherit;cursor:pointer}
        .danmaku-menu [data-bcp-live-follow]:hover{background:#00aeec12}
      `;
      document.head.appendChild(style);
      toolbarButton = document.createElement('button');
      toolbarButton.id = 'bcp-live-toolbar-button'; toolbarButton.type = 'button';
      toolbarButton.setAttribute('aria-label', '跟车设置'); toolbarButton.setAttribute('aria-expanded', 'false');
      toolbarButton.setAttribute('aria-controls', 'bcp-live-panel'); toolbarButton.setAttribute('aria-haspopup', 'dialog');
      toolbarButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l2-5h10l2 5M4 18v2m16-2v2"/><rect x="2.5" y="9" width="19" height="9" rx="2.5"/><path d="M6 13h2m8 0h2m-8 3h4"/></svg>';
      toolbarButton.addEventListener('click', () => {
        checkRoom(); panel.hidden = !panel.hidden;
        toolbarButton.setAttribute('aria-expanded', String(!panel.hidden)); syncTheme(); render();
      });
      panel = document.createElement('div'); panel.id = 'bcp-live-panel'; panel.hidden = true;
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '当前直播间跟车设置');
      panel.innerHTML = `
        <div class="bcp-live-row bcp-live-targets"><span class="bcp-live-label">我来同你玩 <small data-bcp-target-count>0/3</small></span><div class="bcp-live-people" data-bcp-people></div></div>
        <div class="bcp-live-row"><span class="bcp-live-label">开启路怒模式（随机车）</span><button type="button" class="bcp-live-switch" data-bcp-random role="switch" aria-label="开启路怒模式（随机车）" aria-checked="false"><span class="bcp-switch-track" aria-hidden="true"></span><span class="bcp-switch-word">关</span></button></div>
        <div class="bcp-live-row"><span class="bcp-live-label">当前直播间禁用跟车：</span><button type="button" class="bcp-live-switch" data-bcp-disable role="switch" aria-label="当前直播间禁用跟车" aria-checked="false"><span class="bcp-switch-track" aria-hidden="true"></span><span class="bcp-switch-word">关</span></button></div>
        <div class="bcp-live-row"><span class="bcp-live-label">托管</span><button type="button" class="bcp-live-switch" data-bcp-cover-toggle role="switch" aria-label="托管" aria-checked="false"><span class="bcp-switch-track" aria-hidden="true"></span><span class="bcp-switch-word">关</span></button></div>
        <div class="bcp-cover-options"><div class="bcp-cover-colors" aria-label="托管纯色"></div><label class="bcp-cover-upload">选择图片<input type="file" data-bcp-cover-file aria-label="选择托管图片" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/bmp"></label><p data-bcp-cover-status></p><p data-bcp-cover-filename></p></div>
        <div class="bcp-live-row"><span class="bcp-live-label">调整画面风格</span><button type="button" class="bcp-style-preset" data-bcp-style-preset>预设样式</button><button type="button" class="bcp-live-switch" data-bcp-style-toggle role="switch" aria-label="调整画面风格" aria-checked="false"><span class="bcp-switch-track" aria-hidden="true"></span><span class="bcp-switch-word">关</span></button></div><p class="bcp-style-state" data-bcp-style-state></p>`;
      panel.querySelector('[data-bcp-style-preset]').addEventListener('click', () => openStyleEditor(false));
      panel.querySelector('[data-bcp-style-toggle]').addEventListener('click', () => {
        if (!styleSettings.configured) { openStyleEditor(true); return; }
        const next = {...styleSettings, enabled: !styleSettings.enabled};
        if (!writeStyleSettings(next)) { tell('画面风格暂时无法保存，请检查脚本管理器的存储权限。'); return; }
        styleSettings = next; syncStyle();
      });
      for (const [name, color] of COVER_COLORS) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.bcpCoverColor = color;
        button.setAttribute('aria-label', `托管纯色：${name}`); button.title = name; button.style.setProperty('--bcp-swatch', color);
        button.addEventListener('click', () => chooseCoverColor(color)); panel.querySelector('.bcp-cover-colors').appendChild(button);
      }
      panel.querySelector('[data-bcp-cover-toggle]').addEventListener('click', () => { cover.enabled = !cover.enabled; syncCover(); });
      panel.querySelector('[data-bcp-cover-file]').addEventListener('change', event => {
        const file = event.target.files?.[0]; event.target.value = ''; void chooseCoverFile(file);
      });
      panel.querySelector('[data-bcp-random]').addEventListener('click', () => {
        if (settings.targets.length) return;
        changeSettings({random: !settings.random}, settings.disabled ? '设置已保存；当前直播间仍处于禁用状态。' : '路怒模式设置已保存。');
      });
      panel.querySelector('[data-bcp-disable]').addEventListener('click', () => changeSettings({disabled: !settings.disabled},
        settings.disabled ? '已解除当前直播间禁用。' : '当前直播间已禁用跟车，指定对象和随机设置仍保留。'));
      feedback = document.createElement('div'); feedback.id = 'bcp-live-feedback'; feedback.hidden = true;
      feedback.setAttribute('role', 'status');
      document.body.append(panel, feedback); mountToolbar(); render();
    }
    function queueMenu() {
      if (menuQueued) return;
      menuQueued = true;
      queueMicrotask(() => { menuQueued = false; syncMenus(); });
    }
    function syncMenus() {
      for (const menu of document.querySelectorAll('.danmaku-menu')) {
        if (!watchedMenus.has(menu)) {
          watchedMenus.add(menu);
          new MutationObserver(queueMenu).observe(menu, {attributes: true, attributeFilter: ['style', 'class']});
        }
        let button = menu.querySelector('[data-bcp-live-follow]');
        if (!candidate || !visible(menu) || Date.now() - candidate.at > 30000) { button?.remove(); continue; }
        const menuUid = menu.querySelector('.go-space a[href]')?.getAttribute('href')?.match(/space\.bilibili\.com\/(\d+)/)?.[1];
        if (menuUid && menuUid !== candidate.uid) { button?.remove(); continue; }
        if (!button) {
          button = document.createElement('button'); button.type = 'button'; button.setAttribute('data-bcp-live-follow', '1');
          button.addEventListener('click', () => {
            const selected = candidate;
            if (selected && settings.targets.some(person => person.uid === selected.uid)) removeTarget(selected.uid);
            else begin(selected);
            candidate = null; queueMenu();
          });
          (menu.querySelector('.none-select') || menu).appendChild(button);
        }
        const selected = settings.targets.some(person => person.uid === candidate.uid);
        button.disabled = !selected && settings.targets.length >= MAX_TARGETS;
        setText(button, selected ? '取消跟车' : settings.targets.length >= MAX_TARGETS ? '跟车已满（3/3）' : '一键跟车');
        button.title = `指定 ${candidate.name}（UID ${candidate.uid}）${settings.disabled ? '，当前房间禁用中' : ''}`;
      }
    }
    function syncPage() {
      checkRoom(); bindChat(); mountToolbar(); syncCover(); syncStyle();
      // SPA 若复用弹幕容器，只在页面明确显示新房间号后恢复，避免跟发旧房间内容。
      if (awaitingRoom) {
        for (const node of document.querySelectorAll('#control-panel-ctnr-box [data-report]')) {
          try {
            if (String(JSON.parse(node.getAttribute('data-report')).room_id) === room) {
              baseline(); awaitingRoom = false; armRandom(); break;
            }
          } catch (_) {}
        }
      }
      if (candidate) queueMenu();
    }
    function boot() {
      if (!document.body || document.getElementById('bcp-live-toolbar-button')) return;
      createUI(); watchRoom(); watchStyleRoom(); bindChat(); syncMenus(); syncStyle();
      new MutationObserver(() => {
        if (syncQueued) return;
        syncQueued = true;
        queueMicrotask(() => { syncQueued = false; syncPage(); });
      }).observe(document.body, {childList: true, subtree: true});
      document.addEventListener('click', event => {
        const el = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (el?.closest('#bcp-live-panel,#bcp-live-style-dialog,#bcp-live-toolbar-button,[data-bcp-live-follow]')) return;
        closePanel();
        const row = el?.closest(ROW);
        if (row && chat?.contains(row)) {
          candidate = {...readRow(row), at: Date.now()}; queueMenu();
          setTimeout(queueMenu, 100); setTimeout(queueMenu, 400);
        } else if (!el?.closest('.danmaku-menu')) { candidate = null; queueMenu(); }
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { closePanel(); candidate = null; queueMenu(); }
      }, true);
      window.addEventListener('storage', event => {
        if (event.key === storageKey()) acceptSettings(event.newValue);
        if (event.key === STYLE_PREFIX + room) acceptStyleSettings(event.newValue);
      });
      window.addEventListener('pagehide', () => { pageActive = false; resetRuntime(); resetCover(); closeStyleEditor(false); restoreStyleTargets(); styleSvg?.remove(); styleSvg = styleFilters = null; closePanel(); });
      window.addEventListener('pageshow', () => { pageActive = true; syncPage(); baseline(); armRandom(); });
      window.addEventListener('resize', positionPanel);
      window.addEventListener('resize', scheduleCoverLayout);
      document.addEventListener('fullscreenchange', () => { finishCoverGesture(); closeStyleEditor(false); syncCover(); syncStyle(); });
      document.addEventListener('scroll', positionPanel, true);
      window.addEventListener('popstate', syncPage);
      window.setInterval(syncPage, 1000);
    }
    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, {once: true});
  }

})();
