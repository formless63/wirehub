/**
 * The sign-in page — server-rendered, self-contained (inline CSS + a few
 * lines of script), so it needs nothing from the SPA bundle, which stays
 * behind the gate. Same palette as `@wirehub/editor-react/tokens.css`,
 * light and dark, following the studio's stored theme choice.
 */

export interface SignInPageModel {
  /** OIDC button, when configured */
  oidc?: { providerId: string; name: string; emailClaim: string };
  /** the magic-link form, when SMTP is configured */
  magicLink: boolean;
  /** where to go after signing in — already sanitised by the caller */
  next: string;
  /** an error code from the query string (`?error=`) */
  error?: string;
  /** set when a session exists (signed in, or signed in but refused) */
  signedInAs?: { email: string; allowed: boolean };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Plain words for every error code the flows can send back here. Codes only — never echo query text. */
export function signInErrorMessage(code: string, model: Pick<SignInPageModel, 'oidc'>): string {
  switch (code.toUpperCase()) {
    case 'EMAIL_NOT_ALLOWED':
      return 'That account is not allowed to use the studio. Ask the owner to add your email to the allow-list.';
    case 'EMAIL_NOT_FOUND':
      return model.oidc === undefined
        ? 'The sign-in provider did not send an email address.'
        : `${model.oidc.name} did not send the ${model.oidc.emailClaim} claim. Check the client's scopes and custom claims in ${model.oidc.name}.`;
    case 'INVALID_TOKEN':
    case 'EXPIRED_TOKEN':
    case 'ATTEMPTS_EXCEEDED':
      return 'That sign-in link has expired or was already used. Request a new one.';
    case 'ACCESS_DENIED':
      return 'Sign-in was cancelled at the provider.';
    default:
      return `Sign-in did not complete (${code.slice(0, 60)}). Try again.`;
  }
}

export function renderSignInPage(model: SignInPageModel): string {
  const error = model.error === undefined ? '' : `<p class="msg err" role="alert">${esc(signInErrorMessage(model.error, model))}</p>`;
  const who = model.signedInAs;
  let body: string;
  if (who !== undefined && who.allowed) {
    body = `<p class="who">Signed in as <b>${esc(who.email)}</b></p>
<a class="btn primary" href="${esc(model.next)}">Open studio</a>
<button class="btn" type="button" id="sign-out">Sign out</button>`;
  } else {
    const parts: string[] = [];
    if (who !== undefined) {
      parts.push(`<p class="who">Signed in as <b>${esc(who.email)}</b> — not on the allow-list.</p>
<button class="btn" type="button" id="sign-out">Sign out</button>`);
    }
    if (model.oidc !== undefined) {
      parts.push(`<button class="btn primary" type="button" id="oidc" data-provider="${esc(model.oidc.providerId)}">Sign in with ${esc(model.oidc.name)}</button>`);
    }
    if (model.magicLink) {
      if (model.oidc !== undefined) parts.push('<div class="or"><span>or</span></div>');
      parts.push(`<form id="magic" novalidate>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
<button class="btn" type="submit">Email me a sign-in link</button>
</form>`);
    }
    body = parts.join('\n');
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · WireHub</title>
<script>try{var t=localStorage.getItem('wirehub:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>
:root{--bg:#121315;--panel:#18191c;--raised:#1f2024;--line:#27282d;--line2:#34353b;--ink:#ebe8e3;--dim:#a19e96;--faint:#6f6d67;--accent:#e39256;--accent-ink:#1c1008;--ok:#5fbf8a;--err:#ef6461}
[data-theme='light']{--bg:#f7f6f3;--panel:#fff;--raised:#f4f3ef;--line:#e4e2dc;--line2:#d3d0c8;--ink:#1b1a18;--dim:#5f5c55;--faint:#98948b;--accent:#b9622a;--accent-ink:#fff;--ok:#2f8f5b;--err:#c9403c}
@media (prefers-color-scheme:light){:root:not([data-theme='dark']){--bg:#f7f6f3;--panel:#fff;--raised:#f4f3ef;--line:#e4e2dc;--line2:#d3d0c8;--ink:#1b1a18;--dim:#5f5c55;--faint:#98948b;--accent:#b9622a;--accent-ink:#fff;--ok:#2f8f5b;--err:#c9403c}}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--ink);font:13px/1.4 'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{min-height:100%;display:grid;place-items:center;padding:16px}
.card{width:100%;max-width:300px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:10px}
h1{margin:0 0 4px;font-size:14px;font-weight:600;letter-spacing:.01em}
h1 span{color:var(--faint);font-weight:400}
.btn{display:block;width:100%;height:30px;border-radius:5px;border:1px solid var(--line2);background:var(--raised);color:var(--ink);font:inherit;font-weight:500;cursor:pointer;text-align:center;line-height:28px;text-decoration:none}
.btn:hover{border-color:var(--faint)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn:disabled{opacity:.6;cursor:default}
form{display:flex;flex-direction:column;gap:6px;margin:0}
label{color:var(--dim);font-size:12px}
input{height:30px;border-radius:5px;border:1px solid var(--line2);background:var(--bg);color:var(--ink);font:inherit;padding:0 8px}
input:focus,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.or{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:11px}
.or:before,.or:after{content:'';flex:1;border-top:1px solid var(--line)}
.msg{margin:0;font-size:12px}
.msg.err{color:var(--err)}
.msg.ok{color:var(--ok)}
.who{margin:0;color:var(--dim)}
.who b{color:var(--ink);font-weight:500}
</style>
</head>
<body>
<main>
<div class="card">
<h1>WireHub <span>· sign in</span></h1>
${error}
${body}
<p class="msg" id="status" aria-live="polite"></p>
</div>
</main>
<script>
(function(){
var next=${JSON.stringify(model.next).replace(/</g, '\\u003c')};
var status=document.getElementById('status');
function say(text,kind){status.textContent=text;status.className='msg '+(kind||'')}
function post(path,body){return fetch('/api/auth'+path,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {ok:r.ok,body:j}})})}
var oidc=document.getElementById('oidc');
if(oidc)oidc.addEventListener('click',function(){oidc.disabled=true;post('/sign-in/social',{provider:oidc.dataset.provider,callbackURL:next,errorCallbackURL:'/sign-in'}).then(function(r){if(r.ok&&r.body.url){location.href=r.body.url}else{oidc.disabled=false;say(r.body.message||'Could not reach the sign-in provider.','err')}},function(){oidc.disabled=false;say('Could not reach the studio.','err')})});
var form=document.getElementById('magic');
if(form)form.addEventListener('submit',function(e){e.preventDefault();var email=form.email.value.trim();if(!email){say('Enter your email.','err');return}var b=form.querySelector('button');b.disabled=true;post('/sign-in/magic-link',{email:email,callbackURL:next,errorCallbackURL:'/sign-in'}).then(function(r){b.disabled=false;if(r.ok){say('Link sent to '+email+'. It works once, for 10 minutes.','ok')}else{say(r.body.message||'Could not send the link.','err')}},function(){b.disabled=false;say('Could not reach the studio.','err')})});
var out=document.getElementById('sign-out');
if(out)out.addEventListener('click',function(){post('/sign-out',{}).then(function(){location.href='/sign-in'})});
})();
</script>
</body>
</html>
`;
}
