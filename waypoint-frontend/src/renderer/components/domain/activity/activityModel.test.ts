import type { ActivityEntry } from '@/types/entities';
import { filterActivity, groupActivity, limitClusters } from './activityModel';

const NOW = new Date(2026, 8, 30, 15, 0);
function at(day: number, h: number, m = 0) {
  return new Date(2026, 8, day, h, m).toISOString();
}
let n = 0;
function e(verb: ActivityEntry['verb'], actorId: string, createdAt: string): ActivityEntry {
  n += 1;
  return { id: `a${n}`, ticketId: 't', actorId, verb, detail: verb, payload: {}, createdAt };
}

describe('groupActivity', () => {
  it('sections by day, newest first', () => {
    const days = groupActivity([e('created', 'm1', at(28, 9)), e('state_changed', 'm2', at(30, 10))], NOW);
    expect(days.map((d) => d.label)).toEqual(['Today', new Date(2026, 8, 28).toLocaleDateString(undefined, { weekday: 'long' })]);
  });

  it("folds one person's burst into one cluster, but not across a gap or another person", () => {
    const days = groupActivity(
      [
        e('state_changed', 'm1', at(30, 10, 0)),
        e('priority_changed', 'm1', at(30, 10, 10)),
        e('label_added', 'm2', at(30, 10, 12)),
        e('assignee_added', 'm1', at(30, 10, 13)),
        e('due_date_set', 'm1', at(30, 11, 0)),
      ],
      NOW,
    );
    expect(days[0]!.clusters.map((c) => [c.actorId, c.entries.map((x) => x.verb)])).toEqual([
      ['m1', ['due_date_set']],
      ['m1', ['assignee_added']],
      ['m2', ['label_added']],
      ['m1', ['priority_changed', 'state_changed']],
    ]);
  });

  it('lists the changes of one save in reading order', () => {
    const t = at(30, 9);
    const days = groupActivity(
      [e('sprint_changed', 'm1', t), e('label_added', 'm1', t), e('title_changed', 'm1', t), e('state_changed', 'm1', t)],
      NOW,
    );
    expect(days[0]!.clusters[0]!.entries.map((x) => x.verb)).toEqual([
      'title_changed',
      'state_changed',
      'label_added',
      'sprint_changed',
    ]);
  });
});

describe('filterActivity / limitClusters', () => {
  const list = [e('commented', 'm1', at(30, 9)), e('state_changed', 'm1', at(30, 8))];

  it('splits comments from changes', () => {
    expect(filterActivity(list, 'comments').map((x) => x.verb)).toEqual(['commented']);
    expect(filterActivity(list, 'changes').map((x) => x.verb)).toEqual(['state_changed']);
    expect(filterActivity(list, 'all')).toHaveLength(2);
  });

  it('holds back clusters past the limit and says how many', () => {
    const many = Array.from({ length: 5 }, (_, i) => e('state_changed', `m${i}`, at(30, 9, i * 20)));
    const { days, hidden } = limitClusters(groupActivity(many, NOW), 3);
    expect(days.flatMap((d) => d.clusters)).toHaveLength(3);
    expect(hidden).toBe(2);
  });
});
