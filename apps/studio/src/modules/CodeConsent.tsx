/**
 * The consent step of a pack that carries a code module (`specs/runtime-modules.md`
 * §2): what the module is, the extension points and permissions it declares, who
 * signed it, whether it applies at once or partly after a restart, the warning,
 * and a checkbox the person must tick before Install is offered.
 */

import type { JSX } from 'react';

import type { CodePreviewView } from '../code-modules.browser.ts';

export function CodeConsent({ code, agreed, onAgree }: { code: CodePreviewView; agreed: boolean; onAgree: (agreed: boolean) => void }): JSX.Element {
  return (
    <div className="my-2 border border-warn p-2" data-testid="code-consent">
      <div>
        <b>Code module:</b> {code.module.label} ({code.module.id} {code.module.version}, module API {code.module.apiVersion})
      </div>
      <div role="alert" className="text-warn">{code.warning}</div>
      <div>Uses: {code.extensionPoints.join(', ')}</div>
      <div>May: {code.permissions.join(', ')}</div>
      <div>
        Signed by{' '}
        {code.trust.keys.map((k) => (
          <span key={k.key}>
            key {k.keyId} (fingerprint <code>{k.fingerprint}</code>){' '}
          </span>
        ))}
        — trusted {code.trust.via === 'store' ? 'through the store that lists its publisher' : 'by a key pinned on this hub'}.
      </div>
      <div>{code.apply === 'live' ? 'It applies at once, without a restart.' : 'It applies at once; its job queues start after Restart WireHub (Settings).'}</div>
      <label className="mt-1 flex items-center gap-2">
        <input type="checkbox" aria-label="I trust this module to run code in this hub" checked={agreed} onChange={(e) => onAgree(e.target.checked)} />
        I trust {code.module.id} {code.module.version} to run code in this hub.
      </label>
    </div>
  );
}
