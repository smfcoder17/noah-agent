import { t } from "@/i18n";

export function SettingsTwoColumns({ navigation, children }: { navigation: React.ReactNode; children: React.ReactNode }) {
  return <div className="settings-two-columns"><nav aria-label={t("Rubriques")} className="settings-list">{navigation}</nav><div className="settings-detail">{children}</div></div>;
}
