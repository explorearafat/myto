/**
 * Prompt DNA Builder Types
 * Visual block-based prompt construction system
 */

export type PromptBlockType = 'context' | 'task' | 'constraint' | 'format' | 'example'

export interface PromptBlock {
  id: string
  type: PromptBlockType
  content: string
  order: number
  enabled: boolean
  createdAt: number
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  blocks: Omit<PromptBlock, 'id' | 'createdAt'>[]
  tags: string[]
}

export interface PromptCanvas {
  blocks: PromptBlock[]
  mode: 'builder' | 'text'
}

/**
 * Block templates with visual metadata
 */
export interface BlockTemplate {
  type: PromptBlockType
  icon: string
  label: string
  placeholder: string
  description: string
  color: string // Warm accent colors from design system
}

export const BLOCK_TEMPLATES: Record<PromptBlockType, BlockTemplate> = {
  context: {
    type: 'context',
    icon: '📋',
    label: 'Context',
    placeholder: 'I am building a React application with TypeScript...',
    description: 'Background information and current situation',
    color: '#F2E3D6' // Soft terracotta tint
  },
  task: {
    type: 'task',
    icon: '🎯',
    label: 'Task',
    placeholder: 'Create a responsive navigation component that...',
    description: 'What you want the AI to do',
    color: '#E7E1D7' // Warm hairline
  },
  constraint: {
    type: 'constraint',
    icon: '⚙️',
    label: 'Constraints',
    placeholder: 'Must use TypeScript, follow accessibility guidelines, no external dependencies...',
    description: 'Requirements and limitations',
    color: '#FBF9F5' // Warm surface
  },
  format: {
    type: 'format',
    icon: '📄',
    label: 'Output Format',
    placeholder: 'Provide code with inline comments, followed by usage examples...',
    description: 'How the answer should be structured',
    color: '#F7F4EF' // Warm cream
  },
  example: {
    type: 'example',
    icon: '💡',
    label: 'Example',
    placeholder: 'Similar to how the Material UI Button works: <Button variant="contained">Click me</Button>',
    description: 'Reference examples for clarity',
    color: '#FFFFFF' // Pure white
  }
}

/**
 * Predefined templates for common use cases
 */
export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'code-generation',
    name: 'Code Generation',
    description: 'Generate clean, production-ready code',
    tags: ['coding', 'development'],
    blocks: [
      {
        type: 'context',
        content: '',
        order: 0,
        enabled: true
      },
      {
        type: 'task',
        content: '',
        order: 1,
        enabled: true
      },
      {
        type: 'constraint',
        content: 'Use TypeScript with strict mode. Follow best practices for React hooks.',
        order: 2,
        enabled: true
      },
      {
        type: 'format',
        content: 'Provide complete code with type definitions. Include brief inline comments for complex logic.',
        order: 3,
        enabled: true
      }
    ]
  },
  {
    id: 'explanation',
    name: 'Concept Explanation',
    description: 'Learn and understand new topics',
    tags: ['learning', 'education'],
    blocks: [
      {
        type: 'context',
        content: 'I am learning web development.',
        order: 0,
        enabled: true
      },
      {
        type: 'task',
        content: '',
        order: 1,
        enabled: true
      },
      {
        type: 'format',
        content: 'Explain in simple terms with practical examples. Use analogies where helpful.',
        order: 2,
        enabled: true
      }
    ]
  },
  {
    id: 'debugging',
    name: 'Debug & Fix',
    description: 'Solve errors and fix issues',
    tags: ['debugging', 'troubleshooting'],
    blocks: [
      {
        type: 'context',
        content: '',
        order: 0,
        enabled: true
      },
      {
        type: 'task',
        content: 'Help me fix this error:',
        order: 1,
        enabled: true
      },
      {
        type: 'example',
        content: '',
        order: 2,
        enabled: true
      },
      {
        type: 'format',
        content: 'Explain the root cause, then provide the fix with explanation.',
        order: 3,
        enabled: true
      }
    ]
  },
  {
    id: 'refactor',
    name: 'Code Refactor',
    description: 'Improve existing code quality',
    tags: ['refactoring', 'optimization'],
    blocks: [
      {
        type: 'task',
        content: 'Refactor this code to be more maintainable and efficient:',
        order: 0,
        enabled: true
      },
      {
        type: 'example',
        content: '',
        order: 1,
        enabled: true
      },
      {
        type: 'constraint',
        content: 'Keep the same functionality. Prioritize readability and performance.',
        order: 2,
        enabled: true
      },
      {
        type: 'format',
        content: 'Show before/after comparison. Highlight key improvements.',
        order: 3,
        enabled: true
      }
    ]
  },
  {
    id: 'blank',
    name: 'Blank Canvas',
    description: 'Start from scratch',
    tags: ['custom'],
    blocks: []
  }
]
