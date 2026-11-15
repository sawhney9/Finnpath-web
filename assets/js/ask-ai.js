// "Go deeper with AI": opens Claude or ChatGPT in a new tab with the person's inputs and
// results filled in, or copies the same text for any other assistant. Nothing is sent
// anywhere by Finnpath; the prompt only travels in the link the person chooses to open.

const TARGETS = {
  claude: q => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  chatgpt: q => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
};

export function bindAskAI(container, getPrompt, toast) {
  container.addEventListener('click', async e => {
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    const prompt = getPrompt();
    if (!prompt) return toast('Fill in your numbers first.');
    if (b.dataset.ai === 'copy') {
      try { await navigator.clipboard.writeText(prompt); toast('Copied. Paste it into any AI assistant.'); }
      catch (_) { toast('Copy failed. Your browser blocked the clipboard.'); }
      return;
    }
    window.open(TARGETS[b.dataset.ai](prompt), '_blank', 'noopener');
  });
}

export const AI_PREAMBLE = 'This is for education, not personalized financial advice. Ask me questions if you need more detail, and point out any assumptions that look off for someone like me.';
