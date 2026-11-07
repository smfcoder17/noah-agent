/** Nom lisible d'une application du catalogue ou d'un outil. */
export const appLabel = (name: string) => name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
