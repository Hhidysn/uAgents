export class FakeAdapter {
  constructor({ fault = null, events = [{ type: 'succeeded', evidence_strength: 2 }], reconcile = null } = {}) {
    this.fault = fault;
    this.events = events;
    this.reconcileResult = reconcile;
    this.sendCount = 0;
  }

  async prepare(request) {
    if (this.fault === 'prepare') throw coded('fake_prepare_failed');
    return { request };
  }

  async dispatch(prepared, context) {
    if (this.fault === 'before_checkpoint') throw coded('fake_before_checkpoint');
    await context.checkpoint('possibly_sent');
    if (this.fault === 'after_checkpoint') throw coded('fake_after_checkpoint');
    this.sendCount++;
    if (this.fault === 'after_send') throw coded('fake_after_send');
    const handle = { session_id: `fake-session-${context.attemptId}`, task_id: null, status: 'accepted' };
    if (this.fault === 'before_accepted') throw coded('fake_before_accepted');
    await context.checkpoint('accepted', { handle, evidence_ref: 'fake:accepted' });
    return { handle, prepared };
  }

  async *observe() {
    for (const event of this.events) yield { same_native_identity: true, ...event };
  }

  async cancel() { return { confirmed: false }; }

  async reconcile() {
    return { same_native_identity: true, evidence_strength: 3, ...(this.reconcileResult ?? { type: 'succeeded' }) };
  }
}

function coded(code) { return Object.assign(new Error(code), { code }); }
