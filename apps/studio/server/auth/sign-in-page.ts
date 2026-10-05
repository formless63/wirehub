/**
 * The sign-in page — server-rendered, self-contained (inline CSS + a few
 * lines of script), so it needs nothing from the SPA bundle, which stays
 * behind the gate. Same palette as `@wirehub/editor-react/tokens.css`,
 * light and dark, following the studio's stored theme choice.
 */

export interface SignInPageModel {
  /** OIDC button, when configured */
  oidc?: { providerId: string; name: string; emailClaim: string };
  /** sign-in buttons contributed by modules */
  providers?: readonly { providerId: string; name: string }[];
  /** the magic-link form, when SMTP is configured */
  magicLink: boolean;
  /** the email + password form (database backend, plan §9.3) */
  localAccounts?: boolean;
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
      return 'That account is not allowed to use this hub. Ask an administrator to add your email to the allow-list.';
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
      parts.push(`<button class="btn primary" type="button" id="oidc" data-sso data-provider="${esc(model.oidc.providerId)}">Sign in with ${esc(model.oidc.name)}</button>`);
    }
    for (const provider of model.providers ?? []) {
      parts.push(`<button class="btn${model.oidc === undefined && provider === model.providers?.[0] ? ' primary' : ''}" type="button" data-sso data-provider="${esc(provider.providerId)}">Sign in with ${esc(provider.name)}</button>`);
    }
    const sso = model.oidc !== undefined || (model.providers ?? []).length > 0;
    if (model.localAccounts === true) {
      if (sso) parts.push('<div class="or"><span>or</span></div>');
      parts.push(`<form id="password" novalidate>
<label for="pw-email">Email</label>
<input id="pw-email" name="email" type="email" autocomplete="username" required placeholder="you@example.com">
<label for="pw-password">Password</label>
<input id="pw-password" name="password" type="password" autocomplete="current-password" required>
<button class="btn primary" type="submit">Sign in</button>
</form>`);
    }
    if (model.magicLink) {
      if (sso || model.localAccounts === true) parts.push('<div class="or"><span>or</span></div>');
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
Array.prototype.forEach.call(document.querySelectorAll('[data-sso]'),function(oidc){oidc.addEventListener('click',function(){oidc.disabled=true;post('/sign-in/social',{provider:oidc.dataset.provider,callbackURL:next,errorCallbackURL:'/sign-in'}).then(function(r){if(r.ok&&r.body.url){location.href=r.body.url}else{oidc.disabled=false;say(r.body.message||'Could not reach the sign-in provider.','err')}},function(){oidc.disabled=false;say('Could not reach the studio.','err')})})});
var form=document.getElementById('magic');
if(form)form.addEventListener('submit',function(e){e.preventDefault();var email=form.email.value.trim();if(!email){say('Enter your email.','err');return}var b=form.querySelector('button');b.disabled=true;post('/sign-in/magic-link',{email:email,callbackURL:next,errorCallbackURL:'/sign-in'}).then(function(r){b.disabled=false;if(r.ok){say('Link sent to '+email+'. It works once, for 10 minutes.','ok')}else{say(r.body.message||'Could not send the link.','err')}},function(){b.disabled=false;say('Could not reach the studio.','err')})});
var pw=document.getElementById('password');
if(pw)pw.addEventListener('submit',function(e){e.preventDefault();var b=pw.querySelector('button');b.disabled=true;post('/sign-in/email',{email:pw.email.value.trim(),password:pw.password.value,callbackURL:next}).then(function(r){if(r.ok){location.href=next}else{b.disabled=false;say(r.body.message||'That email and password do not match.','err')}},function(){b.disabled=false;say('Could not reach the studio.','err')})});
var out=document.getElementById('sign-out');
if(out)out.addEventListener('click',function(){post('/sign-out',{}).then(function(){location.href='/sign-in'})});
})();
</script>
</body>
</html>
`;
}

/** The invitation page: choose a name and a password; the account is made and signed in. */
export function renderInvitePage(model: { token: string; localAccounts: boolean }): string {
  const form = model.localAccounts
    ? `<form id="accept" novalidate>
<label for="name">Your name</label>
<input id="name" name="name" autocomplete="name" required>
<label for="password">Choose a password (12 characters or more)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<button class="btn primary" type="submit">Join the hub</button>
</form>`
    : '<p class="msg">This hub signs in through its identity provider. <a href="/sign-in">Sign in</a> with the invited email.</p>';
  return renderSignInPage({ magicLink: false, next: '/' })
    .replace('<title>Sign in · WireHub</title>', '<title>Join · WireHub</title>')
    .replace('<h1>WireHub <span>· sign in</span></h1>', '<h1>WireHub <span>· you are invited</span></h1>')
    .replace(/<p class="msg" id="status"/, `${form}\n<p class="msg" id="status"`)
    .replace(
      'var out=document.getElementById',
      `var acc=document.getElementById('accept');
if(acc)acc.addEventListener('submit',function(e){e.preventDefault();var b=acc.querySelector('button');b.disabled=true;fetch('/api/invitations/accept',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:${JSON.stringify(model.token).replace(/</g, '\\u003c')},name:acc.name.value,password:acc.password.value})}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(r.ok){location.href='/'}else{b.disabled=false;say(j.error||j.message||'Could not accept the invitation.','err')}})},function(){b.disabled=false;say('Could not reach the studio.','err')})});
var out=document.getElementById`,
    );
}

/** Account → API tokens (B12): a person's own tokens; create one (shown once), revoke one. */
export function renderTokensPage(): string {
  const body = `<p class="who">Tokens let a script or an agent use the studio as you. Each is shown once.</p>
<form id="create" novalidate>
<label for="tname">What is it for?</label>
<input id="tname" name="tname" maxlength="80" required placeholder="laptop scripts">
<label><input type="checkbox" id="write"> may change the catalog (catalog:write)</label>
<label><input type="checkbox" id="imports"> may write imported documents (imports)</label>
<label for="days">Expires after</label>
<select id="days" name="days"><option>1</option><option selected>7</option><option>30</option><option>90</option></select>
<button class="btn primary" type="submit">Create token</button>
</form>
<p class="msg ok" id="secret" style="word-break:break-all"></p>
<ul id="list" class="who"></ul>`;
  return renderSignInPage({ magicLink: false, next: '/' })
    .replace('<title>Sign in · WireHub</title>', '<title>API tokens · WireHub</title>')
    .replace('<h1>WireHub <span>· sign in</span></h1>', '<h1>WireHub <span>· API tokens</span></h1>')
    .replace('max-width:300px', 'max-width:520px')
    .replace(/<p class="msg" id="status"/, `${body}\n<p class="msg" id="status"`)
    .replace(
      'var out=document.getElementById',
      `function api(m,b){return fetch('/api/account/tokens'+(m==='DELETE'?'/'+b:''),{method:m,headers:{'content-type':'application/json'},credentials:'same-origin',body:m==='POST'?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j}})})}
function load(){fetch('/api/account/tokens',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){var ul=document.getElementById('list');ul.textContent='';(j.tokens||[]).forEach(function(t){var li=document.createElement('li');li.textContent=t.name+' · cst_'+t.env+'_'+t.prefix+'… · '+t.scopes.join(' ')+' · expires '+t.expiresAt.slice(0,10)+(t.revokedAt?' · revoked':'')+(t.lastUsedAt?' · last used '+t.lastUsedAt.slice(0,16):'');if(!t.revokedAt){var b=document.createElement('button');b.className='btn';b.textContent='Revoke';b.onclick=function(){api('DELETE',t.id).then(load)};li.appendChild(b)}ul.appendChild(li)})})}
var cr=document.getElementById('create');
if(cr){load();cr.addEventListener('submit',function(e){e.preventDefault();var scopes=['read'];if(document.getElementById('write').checked)scopes.push('catalog:write');if(document.getElementById('imports').checked)scopes.push('imports');api('POST',{name:cr.tname.value,scopes:scopes,days:Number(cr.days.value)}).then(function(r){if(r.ok){document.getElementById('secret').textContent='Copy it now — it is not shown again: '+r.body.secret;load()}else{say(r.body.error||'Could not create the token.','err')}})})}
var out=document.getElementById`,
    );
}

/** Settings → People (S4): who is in the hub, their roles, invitations, revoking access. Owners only (the API says so). */
export function renderPeoplePage(): string {
  const body = `<p class="who">Who may use this hub, and what they may do: an <b>owner</b> manages people, an <b>editor</b> changes the catalog, a <b>viewer</b> reads.</p>
<ul id="people" class="who" style="padding-left:16px"></ul>
<form id="invite" novalidate>
<label for="iemail">Invite by email</label>
<input id="iemail" name="iemail" type="email" required placeholder="someone@example.com">
<label for="irole">Role</label>
<select id="irole" name="irole"><option>editor</option><option>viewer</option><option>owner</option></select>
<button class="btn primary" type="submit">Invite</button>
</form>
<p class="msg ok" id="link" style="word-break:break-all"></p>
<ul id="invites" class="who" style="padding-left:16px"></ul>
<p class="who"><a href="/">Back to the studio</a> · <a href="/account/tokens">My API tokens</a></p>`;
  return renderSignInPage({ magicLink: false, next: '/' })
    .replace('<title>Sign in · WireHub</title>', '<title>People · WireHub</title>')
    .replace('<h1>WireHub <span>· sign in</span></h1>', '<h1>WireHub <span>· people</span></h1>')
    .replace('max-width:300px', 'max-width:560px')
    .replace(/<p class="msg" id="status"/, `${body}\n<p class="msg" id="status"`)
    .replace(
      'var out=document.getElementById',
      `function call(m,p,b){return fetch(p,{method:m,headers:{'content-type':'application/json'},credentials:'same-origin',body:b===undefined?undefined:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {ok:r.ok,body:j}})})}
function el(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e}
function load(){call('GET','/api/people').then(function(r){if(!r.ok){say(r.body.error||'Only an owner manages people.','err');return}var ul=document.getElementById('people');ul.textContent='';r.body.people.forEach(function(p){var li=el('li',p.name+' <'+p.email+'> ');var sel=el('select');['owner','editor','viewer'].forEach(function(x){var o=el('option',x);if(x===p.role)o.selected=true;sel.appendChild(o)});sel.onchange=function(){call('PATCH','/api/people/'+p.id,{role:sel.value}).then(function(x){if(!x.ok)say(x.body.error,'err');load()})};li.appendChild(sel);var b=el('button',p.disabledAt?'Give access back':'Revoke access');b.className='btn';b.onclick=function(){call('POST','/api/people/'+p.id+'/'+(p.disabledAt?'enable':'disable')).then(function(x){if(!x.ok)say(x.body.error,'err');load()})};if(p.disabledAt)li.appendChild(el('span',' (access revoked) '));li.appendChild(b);ul.appendChild(li)});var iv=document.getElementById('invites');iv.textContent='';r.body.invitations.filter(function(i){return !i.acceptedAt}).forEach(function(i){var li=el('li','invited: '+i.email+' as '+i.role+', until '+i.expiresAt.slice(0,10)+' ');var b=el('button','Withdraw');b.className='btn';b.onclick=function(){call('DELETE','/api/invitations/'+i.id).then(load)};li.appendChild(b);iv.appendChild(li)})})}
var inv=document.getElementById('invite');
if(inv){load();inv.addEventListener('submit',function(e){e.preventDefault();call('POST','/api/invitations',{email:inv.iemail.value,role:inv.irole.value}).then(function(r){if(r.ok){document.getElementById('link').textContent='Send this link to '+r.body.invitation.email+' (shown once): '+r.body.link;inv.iemail.value='';load()}else{say(r.body.error||'Could not invite.','err')}})})}
var out=document.getElementById`,
    );
}
