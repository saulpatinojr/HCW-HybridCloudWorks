import React from 'react';

/**
 * The sample lab terminal session (init, lint, syntax check) shown on the
 * lab pre-flight card and the home page's workbench showcase. Each place
 * passes its own text sizes and colours.
 *
 * @param {object} props
 * @param {string} props.className     Classes for the list of lines.
 * @param {string} props.noteClassName Classes for the grey "✓ ..." output.
 * @param {string} props.passClassName Classes for the green "PASS" output.
 */
export default function LabTerminalTranscript({ className, noteClassName, passClassName }) {
  return (
    <div className={className}>
      <div>
        <span className="text-emerald-400">$ </span>
        <span className="text-slate-100">terraform init &amp;&amp; tflint --module</span>
      </div>
      <div className={noteClassName}>
        ✓ Initialized providers: azurerm, aws, google
        <br />✓ Linting complete: 0 issues found (AVM policy passed)
      </div>
      <div>
        <span className="text-emerald-400">$ </span>
        <span className="text-slate-100">ansible-playbook --syntax-check site.yml</span>
      </div>
      <div className={passClassName}>playbook: site.yml [PASS - syntax verified]</div>
    </div>
  );
}
