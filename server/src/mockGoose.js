import { appendTaskLog, updateTask } from './db.js';

const BOSS_NAME = 'Rajiv Gupta';
const CODING_AGENT_NAMES = ['Manish Malik', 'Sanjeev Lamba', 'Rajiv Jamwal'];
const QUALITY_PILOT_NAMES = ['Navdeep', 'Manish Srivastva'];
const THINKING = [
  'thinking through edge cases...',
  'reviewing constraints...',
  'waiting for LLM response...',
  'planning next step...'
];

export function runMockGoose(task, broadcast) {
  return new Promise((resolve) => {
    let index = 0;
    const qualityTask = /(test|qa|spec|assert|ci|verification|quality)/i.test(`${task?.title || ''} ${task?.description || ''}`);
    const worker = (qualityTask ? QUALITY_PILOT_NAMES : CODING_AGENT_NAMES)[task.id % 3] || CODING_AGENT_NAMES[0];
    const scripts = [
      `${BOSS_NAME} (Boss)> booting runtime...`,
      `${worker}> ${THINKING[Math.floor(Math.random() * THINKING.length)]}`,
      `${worker}> hydrating task prompt from Context7 items...`,
      `${worker}> loading MCP plugin registry...`,
      `${worker}> executing: goose run --text "<hydrated_prompt>"`,
      `${worker}> waiting for LLM response...`,
      `${worker}> Drafting implementation plan and code edits now.`,
      `${worker}> ${THINKING[Math.floor(Math.random() * THINKING.length)]}`,
      `${worker}> generating patch and tests...`,
      `${worker}> pulling latest branch refs...`,
      `${worker}> pushing branch + opening PR...`,
      `${BOSS_NAME} (Boss)> done.`
    ];

    const running = updateTask(task.id, { runtimeStatus: 'running' });
    broadcast({ type: 'task_status', task: running });

    const timer = setInterval(() => {
      if (index < scripts.length) {
        appendTaskLog(task.id, scripts[index]);
        broadcast({ type: 'task_log', taskId: task.id, line: scripts[index] });
        index += 1;
        return;
      }

      clearInterval(timer);
      const done = updateTask(task.id, {
        status: 'review',
        runtimeStatus: Math.random() > 0.12 ? 'success' : 'failed'
      });
      broadcast({ type: 'task_status', task: done });
      resolve(done);
    }, 900);
  });
}
