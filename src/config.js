function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(value) {
  const base = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function aesKey(secret) {
  if (!secret) throw new Error("CONFIG_SECRET is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealConfig(config, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const plain = new TextEncoder().encode(JSON.stringify({
    apiKey: String(config.apiKey || "").trim(),
    model: String(config.model || "gemini-3.5-flash-lite").trim(),
  }));
  if (!JSON.parse(new TextDecoder().decode(plain)).apiKey) throw new Error("Gemini API key is required");
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const joined = new Uint8Array(iv.length + cipher.length);
  joined.set(iv, 0);
  joined.set(cipher, iv.length);
  return b64url(joined);
}

export async function openConfig(token, secret) {
  const packed = fromB64url(token);
  if (packed.length < 29) throw new Error("Invalid SmartSubs configuration token");
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const key = await aesKey(secret);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  } catch {
    throw new Error("Invalid SmartSubs configuration token");
  }
  const config = JSON.parse(new TextDecoder().decode(plain));
  if (!config.apiKey) throw new Error("SmartSubs configuration has no Gemini API key");
  return config;
}

export function configureHtml(origin) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:680px;margin:48px auto;padding:0 20px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border-radius:10px;border:1px solid #444;background:#1c1c1c;color:#fff}button{cursor:pointer;font-weight:700}small{color:#aaa}#out{word-break:break-all;margin-top:16px}</style></head>
<body><h1>SmartSubs</h1><p>Fast Malay subtitle translation. Your Gemini key is encrypted into the configured add-on URL and is not stored in GitHub.</p>
<label>Gemini API key</label><input id="key" type="password" autocomplete="off" placeholder="AIza...">
<label>Model</label><input id="model" value="gemini-3.5-flash-lite">
<button id="make">Create configured manifest</button><div id="out"></div>
<small>No expiry or revocation layer is added in M21.</small>
<script>
document.getElementById('make').onclick=async()=>{const out=document.getElementById('out');out.textContent='Creating...';const r=await fetch('/configure/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:document.getElementById('key').value,model:document.getElementById('model').value})});const j=await r.json();if(!r.ok){out.textContent=j.error||'Failed';return}out.innerHTML='<p>Install this manifest in Stremio:</p><a style="color:#9cf" href="'+j.manifestUrl+'">'+j.manifestUrl+'</a>'};
</script></body></html>`;
}
