/*
 * Command quick actions — one-shot, curated tasks that run the agent without
 * the user composing a prompt. Built-ins cover the common flows (explain,
 * review, test, memory); prompt-kind plugins from the plugin system append to
 * this list at runtime. Pure builders: every action derives its task text from
 * the current workspace so nothing is hardcoded to one machine.
 */
export interface QuickAction {
  id: string
  label: string
  hint: string
  task: (workspace: string) => string
}

/** The built-in quick actions, in display order. */
export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'explain',
    label: 'Explain this codebase',
    hint: 'a guided tour of the project',
    task: (ws) => `Explore the project at ${ws} and give me a guided tour: what it is, the main modules and how they connect, the entry points, and the commands to build, test and run it. Keep it structured and under 60 lines.`
  },
  {
    id: 'review',
    label: 'Review uncommitted changes',
    hint: 'honest review of the working diff',
    task: (ws) => `Review the uncommitted changes in the git repo at ${ws} (run git diff and git status yourself). For each changed file: what changed, whether it looks correct, and any bugs, edge cases or style drift. Finish with the top issues ranked by severity. Do not edit any files.`
  },
  {
    id: 'write-tests',
    label: 'Write tests for recent changes',
    hint: 'covers the current working diff',
    task: (ws) => `Look at the uncommitted changes in ${ws} (git diff), pick the most test-worthy untested code, and write focused tests following the repo's existing test style. Run the test suite when done and report the real results.`
  },
  {
    id: 'fix-tests',
    label: 'Run tests and fix failures',
    hint: 'green or an honest report',
    task: (ws) => `Run the project's test suite in ${ws}. If tests fail, diagnose the root cause (not the symptom), fix it with the smallest change that is actually correct, and re-run. If something cannot be fixed, stop and report exactly what failed and why.`
  },
  {
    id: 'init-memory',
    label: 'Write a project memory (MYTO.md)',
    hint: 'the /init survey',
    task: (ws) => `Survey this project (${ws}) and write a MYTO.md memory file at its root. Cover in brief: what the project is, the folder layout that matters, the build/test/run commands, and the conventions a coding agent should follow when editing here. Keep it under 60 lines. Create or overwrite MYTO.md.`
  }
]
