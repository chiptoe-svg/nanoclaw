/**
 * Skill-learning guard adapter — the module's catalog entry.
 *
 * An agent-proposed skill change is held for the agent group's admin chain
 * every time: a skill is standing instructions every future session loads,
 * so nothing the agent writes becomes one without a human reading it.
 */
import { DENY, HOLD, defineGuardedAction } from '../../guard/index.js';

export const skillLearningPropose = defineGuardedAction({
  action: 'skill_learning.propose',
  grantActionName: 'propose_skill',
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('propose_skill is a container-originated action.');
    return HOLD('agent-written skills always require admin approval');
  },
});
