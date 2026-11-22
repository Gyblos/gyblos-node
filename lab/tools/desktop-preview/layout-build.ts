// Preview layout rewrites: title bar conversation menu and the chat details panel.
export const TITLEBAR_REWRITES: [string, string][] = [
  [
    '  const title =\n',
    '  const previewTitle = usePreviewConversationTitle(conversation);\n  const title =\n',
  ],
  ['        ? conversation.title\n', '        ? previewTitle\n'],
  [
    'data-platform={platform}',
    "data-platform={platform}\n      data-fullscreen={new URLSearchParams(location.search).get('fullscreen') === '1' || undefined}",
  ],
  [
    '{props.route.current === UI_VIEW.CONNECT && (',
    '{props.route.current === UI_VIEW.CHAT && <PreviewConversationMenu chat={props.chat} />}\n        {(props.route.current === UI_VIEW.CONNECT || props.route.current === UI_VIEW.CHAT) && (',
  ],
  [
    "props.contextOpen\n                ? 'Hide connection context'\n                : 'Show connection context'",
    "props.route.current === UI_VIEW.CHAT\n                ? props.contextOpen ? 'Hide conversation details' : 'Show conversation details'\n                : props.contextOpen ? 'Hide connection context' : 'Show connection context'",
  ],
];

export const APP_LAYOUT_REWRITES: [string, string][] = [
  [
    '          <div className="chat-root" hidden={view !== UI_VIEW.CHAT}>\n',
    '          {view === UI_VIEW.CHAT && contextOpen && <PreviewChatDetails chat={chatController} onClose={() => setContextOpen(false)} />}\n          <div className="chat-root" hidden={view !== UI_VIEW.CHAT}>\n',
  ],
];
