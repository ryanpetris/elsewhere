// Request a desktop transfer and approve it from the current controller.
export async function approveControl(controller, participant) {
  await participant.evaluate(() => elsewhere.requestControl());
  const id = await participant.evaluate(() => elsewhere.store.get().participantId);
  await controller.waitForFunction(id => elsewhere.store.get().roster?.sessions.find(s => s.id === id)?.request, id);
  await controller.evaluate(id => {
    const member = elsewhere.store.get().roster.sessions.find(s => s.id === id);
    elsewhere.decideControl(id, member.request, true);
  }, id);
  await participant.waitForFunction(() => elsewhere.store.get().role === 'controller');
}
