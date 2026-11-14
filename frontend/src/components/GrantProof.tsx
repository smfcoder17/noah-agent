import { Input, Label } from "./ui";
import { t } from "@/i18n";

/** Ce que demande l'accord d'un nouvel appareil quand le mot de passe n'a pas été saisi ici depuis 15 minutes. */
export function GrantProof({ password, code, needCode, onPassword, onCode }: {
  password: string;
  code: string;
  needCode: boolean;
  onPassword: (v: string) => void;
  onCode: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {t("Confirme que c'est bien toi : un appareil volé ne doit pas pouvoir en relier un autre.")}{needCode && ` ${t("Un code de secours marche aussi.")}`}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Label className="min-w-40 flex-1">
          {t("Ton mot de passe")}
          <Input id="grant-password" type="password" autoComplete="current-password" value={password} onChange={(e) => onPassword(e.target.value)} />
        </Label>
        {needCode && (
          <Label className="min-w-40 flex-1">
            {t("Code de l'application")}
            <Input id="grant-code" autoComplete="one-time-code" maxLength={32} className="font-mono" value={code} onChange={(e) => onCode(e.target.value)} />
          </Label>
        )}
      </div>
    </div>
  );
}
