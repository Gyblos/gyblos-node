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
    '<ConversationMenu chat={props.chat} notify={props.notify} />',
    '<PreviewConversationMenu chat={props.chat} />',
  ],
];
