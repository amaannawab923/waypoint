import { isDisclosedAgentHtml } from './TicketDetailPage';

describe('isDisclosedAgentHtml', () => {
  it('matches only the builder’s disclosure openings', () => {
    expect(
      isDisclosedAgentHtml(
        '<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>text</p>',
      ),
    ).toBe(true);
    expect(
      isDisclosedAgentHtml(
        '<p><em>Hi, this is a Waypoint session — Amaan’s agent — reporting on their behalf: </em></p><h3>x</h3>',
      ),
    ).toBe(true);
    // A typed comment arrives entity-escaped from the REST path.
    expect(
      isDisclosedAgentHtml('&lt;p&gt;&lt;em&gt;Hi, this is Copilot — x'),
    ).toBe(false);
    expect(isDisclosedAgentHtml('plain text')).toBe(false);
    expect(isDisclosedAgentHtml('<p>hello</p>')).toBe(false);
  });
});
