import type { SkillConfig } from '../../shared/types'
import {
  registerExtensionTool,
  unregisterExtensionTools,
  extensionToolNames,
  type ToolDef
} from '../tools/registry'

/*
 * The skills manager.
 *
 * A skill is a reusable instruction pack (see {@link SkillConfig}). Each ENABLED skill
 * is registered as a runtime tool named `skill__<slug>` in the tool registry's
 * extension layer. The model sees the skill's one-line description in the tool list
 * and, when a task matches, calls the tool to load the full instructions into context —
 * the same progressive-disclosure model Claude's Skills use, so the base prompt stays
 * lean while deep know-how is a single call away.
 *
 * Unlike connectors there is nothing async here: {@link syncSkills} just reconciles the
 * registered `skill__*` tools against the enabled list. It is called on startup and
 * from the settings-saved listener, so editing a skill takes effect on the next turn.
 */

/** The tool-name prefix every skill tool shares (so sync can find them to clear). */
const SKILL_PREFIX = 'skill__'

/** A skill name → a safe slug for the tool name (`PDF Forms` → `pdf_forms`). */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'skill'
  )
}

/** The tool name a skill is registered under. */
export function skillToolName(name: string): string {
  return `${SKILL_PREFIX}${skillSlug(name)}`
}

/** Wrap one skill as a tool whose result is the skill's full instructions. */
function wrapSkill(skill: SkillConfig): ToolDef {
  const name = skillToolName(skill.name)
  const desc = skill.description || 'A reusable instruction pack.'
  return {
    name,
    // The description is what the model reads to decide whether the skill applies.
    description: `Skill "${skill.name}": ${desc} Call this to load its full step-by-step instructions before doing the task.`,
    usage: '{}',
    // Loading instructions changes nothing on disk — read-only, never gated.
    available: (gate) => gate.settings.tools.enabled,
    async run() {
      return `Skill "${skill.name}" — follow these instructions:\n\n${skill.instructions}`
    }
  }
}

/**
 * Reconcile the registered `skill__*` tools against the enabled skills. Clears every
 * existing skill tool, then registers the enabled ones — so a rename, disable, or edit
 * is reflected without leaving a stale tool behind.
 */
export function syncSkills(skills: SkillConfig[]): void {
  const stale = extensionToolNames().filter((n) => n.startsWith(SKILL_PREFIX))
  if (stale.length) unregisterExtensionTools(stale)
  for (const skill of skills) {
    if (skill.enabled) registerExtensionTool(wrapSkill(skill))
  }
}
