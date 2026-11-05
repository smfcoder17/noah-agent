// Sous Windows, le programme garde sinon l'icône d'Electron et son nom, visibles sur les raccourcis et dans le gestionnaire de
// tâches. L'édition intégrée à electron-builder (signAndEditExecutable) télécharge une archive pleine de liens symboliques, que
// Windows refuse de créer sans le mode développeur : npm run dist échouerait sur un poste ordinaire.
const path = require("node:path");

exports.default = async function nameTheProgram(context) {
  if (context.electronPlatformName !== "win32") return;
  const { rcedit } = await import("rcedit");
  const { appInfo } = context.packager;
  await rcedit(path.join(context.appOutDir, `${appInfo.productFilename}.exe`), {
    icon: await context.packager.getIconPath(),
    "file-version": appInfo.version,
    "product-version": appInfo.version,
    "version-string": {
      ProductName: appInfo.productName,
      FileDescription: appInfo.productName,
      CompanyName: appInfo.companyName,
      LegalCopyright: `Copyright ${new Date().getFullYear()} ${appInfo.companyName}`,
      OriginalFilename: `${appInfo.productFilename}.exe`,
    },
  });
};
