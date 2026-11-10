export function ChatPane({ title, onAgent, actions, children }: { title: string; onAgent: () => void; actions?: React.ReactNode; children: React.ReactNode }) {
  return <main className="chat-pane"><header><button onClick={onAgent} className="font-semibold text-[15px]">{title}</button><div className="flex gap-1">{actions}</div></header>{children}</main>;
}
