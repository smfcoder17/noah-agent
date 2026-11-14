import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { EDITEUR_EMAIL } from "@/lib/editeur";
import { MOTIFS, reportMailto } from "@/lib/signalement";
import { ReportAnswer } from "./ReportAnswer";

const body = (href: string) => decodeURIComponent(new URL(href).searchParams.get("body") ?? "");

it("signaler une réponse : fenêtre dans l'app, motif obligatoire, puis un e-mail à l'éditeur avec la réponse", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<ReportAnswer readText={() => "Une réponse blessante."} />));
  const flag = host.querySelector<HTMLButtonElement>('button[aria-label="Signaler la réponse"]')!;
  expect(flag).not.toBeNull();
  await act(async () => flag.click());

  // La fenêtre (portail Radix) : rien ne part sans motif.
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Signaler cette réponse");
  expect(dialog.textContent).toContain(EDITEUR_EMAIL);
  expect(dialog.querySelector("a[href^='mailto:']")).toBeNull();
  const send = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Envoyer par e-mail")!;
  expect(send.disabled).toBe(true);

  const radio = dialog.querySelector<HTMLInputElement>(`input[value="${MOTIFS[0]}"]`)!;
  await act(async () => radio.click());
  const link = dialog.querySelector<HTMLAnchorElement>("a[href^='mailto:']")!;
  expect(link.textContent).toBe("Envoyer par e-mail");
  expect(link.href.startsWith(`mailto:${EDITEUR_EMAIL}?`)).toBe(true);
  expect(body(link.href)).toContain(`Motif : ${MOTIFS[0]}`);
  expect(body(link.href)).toContain("Une réponse blessante.");

  link.addEventListener("click", (e) => e.preventDefault()); // jsdom ne suit pas les liens
  await act(async () => link.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("relis-le, puis envoie-le");
  await act(async () => root.unmount());
  host.remove();
});

it("l'e-mail garde le commentaire et coupe une très longue réponse", () => {
  const href = reportMailto("Autre", "  trop agressif ", "x".repeat(5000), new Date("2026-11-13T10:00:00Z"));
  const text = body(href);
  expect(text).toContain("Commentaire : trop agressif");
  expect(text).toContain("Date : 2026-11-13T10:00:00.000Z");
  expect(text).toContain(`${"x".repeat(1200)}…`);
  expect(text).not.toContain("x".repeat(1201));
  expect(decodeURIComponent(new URL(href).searchParams.get("subject") ?? "")).toBe("Signalement d'une réponse de Noah : Autre");
  expect(reportMailto("Autre", "", "r")).not.toContain("Commentaire");
});
