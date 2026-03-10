import { globalManifest } from "#app/global-manifest";

export function getCachedUrl(url: string): string {
  const manifest = globalManifest;
  if (!manifest) {
    return url;
  }

  const timestamp = manifest[`/${url.replace("./", "")}`];
  if (timestamp) {
    url += `?t=${timestamp}`;
  }
  return url;
}

export function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(getCachedUrl(url), init);
}
