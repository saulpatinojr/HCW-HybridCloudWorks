/**
 * RoleGate (AP-F4, #928): a control the signed-in role cannot use is rendered
 * disabled with the reason beneath it, named through aria-describedby; at
 * or above the role it is the control as written; without a known role the
 * gate has nothing to say.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AdminRoleProvider } from '@/hooks/useAdminRole';
import RoleGate, { roleGateReason } from './RoleGate';

const REASON = 'Publishing needs the publisher role.';

function renderGate(role, props = {}) {
  const onClick = vi.fn();
  const gate = (
    <RoleGate minRole="publisher" reason={REASON} {...props}>
      <button type="button" onClick={onClick}>
        Publish
      </button>
    </RoleGate>
  );
  render(role === undefined ? gate : <AdminRoleProvider value={role}>{gate}</AdminRoleProvider>);
  return { onClick, button: screen.getByRole('button', { name: 'Publish' }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RoleGate', () => {
  it('renders the control as written at the role and above', () => {
    for (const role of ['publisher', 'super_admin']) {
      const { onClick, button } = renderGate(role);
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(button).not.toHaveAttribute('aria-describedby');
      expect(screen.queryByText(REASON)).not.toBeInTheDocument();
      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
      document.body.innerHTML = '';
    }
  });

  it('renders the control disabled below the role, with the reason beneath it', () => {
    const { onClick, button } = renderGate('editor');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Still in the tab order: a `disabled` button would vanish from a
    // screen reader instead of explaining itself.
    expect(button).not.toBeDisabled();
    const reason = screen.getByText(REASON);
    expect(button).toHaveAttribute('aria-describedby', reason.id);
    expect(button).toHaveAccessibleDescription(REASON);
    // Beneath, not beside or before: the sentence follows the control.
    expect(button.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.className).toContain('opacity-50');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('writes the reason itself when the call site gives none', () => {
    renderGate('viewer', { reason: undefined });
    expect(
      screen.getByText('Needs the publisher role; you are signed in as viewer.')
    ).toBeInTheDocument();
    expect(roleGateReason('publisher', 'super_admin')).toBe(
      'Needs the publisher role; you are signed in as super admin.'
    );
  });

  it('gates each element child and leaves text alone', () => {
    render(
      <AdminRoleProvider value="editor">
        <RoleGate minRole="publisher" reason={REASON}>
          <button type="button">One</button>
          {false}
          <button type="button">Two</button>
          and a note
        </RoleGate>
      </AdminRoleProvider>
    );
    for (const name of ['One', 'Two']) {
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(REASON);
    }
    expect(screen.getByText(/and a note/)).toBeInTheDocument();
    expect(screen.getAllByText(REASON)).toHaveLength(1);
  });

  it('has nothing to say without a provider, so the control stays as written', () => {
    const { onClick, button } = renderGate(undefined);
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown role at the render, the way the server refuses "publishor"', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <AdminRoleProvider value="super_admin">
          <RoleGate minRole="publishor">
            <button type="button">Publish</button>
          </RoleGate>
        </AdminRoleProvider>
      )
    ).toThrow(/unknown role "publishor"/);
  });
});
