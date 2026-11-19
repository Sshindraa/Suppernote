/** Consignes vues par le modèle : tous les messages système, l'état du tour étant dans celui qui suit l'historique. */
export function systemOf(messages: ReadonlyArray<{ role?: string; content: unknown }>) {
  return {
    role: 'system' as const,
    content: messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n\n'),
  };
}
