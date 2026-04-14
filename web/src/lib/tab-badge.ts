const originalHref = "/favicon-32.png";
let faviconImg: HTMLImageElement | null = null;
let faviconLoaded = false;
let lastCount = -1;

function getFaviconLink(): HTMLLinkElement | null {
  return document.querySelector('link[rel="icon"]');
}

function loadFaviconImage(): Promise<HTMLImageElement> {
  if (faviconImg && faviconLoaded) return Promise.resolve(faviconImg);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      faviconImg = img;
      faviconLoaded = true;
      resolve(img);
    };
    img.onerror = () => resolve(img); // degrade gracefully
    img.src = originalHref;
  });
}

export async function updateFaviconBadge(count: number): Promise<void> {
  if (count === lastCount) return;
  lastCount = count;

  const link = getFaviconLink();
  if (!link) return;

  if (count <= 0) {
    link.href = originalHref;
    return;
  }

  const img = await loadFaviconImage();
  if (!faviconLoaded) return;

  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Draw original favicon
  ctx.drawImage(img, 0, 0, size, size);

  // Draw badge
  const text = count > 9 ? "9+" : String(count);
  const radius = count > 9 ? 10 : 8;
  const cx = size - radius;
  const cy = size - radius;

  // Red circle
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.fillStyle = "#ef4444";
  ctx.fill();

  // White text
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${count > 9 ? 10 : 12}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);

  link.href = canvas.toDataURL("image/png");
}

const BASE_TITLE = "Code Triage";

export function updateTitleBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}
