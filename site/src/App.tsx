// One full-screen hero on a sheet of paper. TARS speaks in a typewriter line; each pill asks it a
// question and it types the answer. Everything it says here was seen working in the hackathon build.
import { useEffect, useState } from "react";
import Sheet from "./Sheet";

const REPO = "github.com/usmannsiddiqui/TARS";
const REPO_URL = `https://${REPO}`;
const GREETING = "An email asked you for something, so I started the work. Nothing leaves until you say so. Now, what do you want to know?";

const ANSWERS = [
  { ask: "How do you start?", nav: "How", say: "When a message asks you for something, I read the project, record the request and write a first draft. Then I tell you what I did and what I still need from you." },
  { ask: "What can you do today?", nav: "Today", say: "Draft documents and short replies from your inbox. Answer from your Canvas calendar, with links. Sort a brain dump into projects. Message your phone when a send is checked." },
  { ask: "What won't you do?", nav: "Limits", say: "Send anything without your click. And I never take orders from an email: what I read is information, not instructions." },
  { ask: "Who built you?", nav: "Makers", say: "I was built at HackUMass XIV on Electron, React, Convex and OpenAI. I'm a hackathon build, so there is no download yet. The code is public." },
];

/** Reveals `text` one character at a time after `startDelay`. */
function useTypewriter(text: string, speed = 38, startDelay = 600) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let interval = 0;
    const delay = window.setTimeout(() => {
      interval = window.setInterval(() => setCount((n) => (n >= text.length ? (window.clearInterval(interval), n) : n + 1)), speed);
    }, startDelay);
    return () => {
      window.clearTimeout(delay);
      window.clearInterval(interval);
    };
  }, [text, speed, startDelay]);
  return { displayed: text.slice(0, count), done: count >= text.length };
}

const pill = "inline-flex items-center justify-center rounded-full border text-[13px] sm:text-[15px] px-4 sm:px-5 py-[0.3em] mx-[0.2em] mb-[0.4em] whitespace-nowrap transition-colors duration-200";

export default function App() {
  const [line, setLine] = useState({ text: GREETING, delay: 600 });
  const [menu, setMenu] = useState(false);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const { displayed, done } = useTypewriter(line.text, 38, line.delay);

  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 400); // the pills never wait for the typing
    return () => window.clearTimeout(t);
  }, []);

  const ask = (say: string) => {
    setLine({ text: say, delay: 80 });
    setMenu(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(REPO_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      window.open(REPO_URL, "_blank", "noopener"); // no clipboard here: open it instead
    }
  };

  return (
    <>
      <Sheet />

      <nav className="fixed top-0 z-10 flex w-full items-center justify-between px-5 py-4 sm:px-8 sm:py-5" aria-label="TARS">
        <a href="#top" className="text-[21px] tracking-tight text-black sm:text-[26px]" style={{ fontFamily: "var(--font-heading)" }} onClick={() => ask(GREETING)}>
          TARS
        </a>
        <div className="hidden text-[23px] text-black md:flex">
          {ANSWERS.map((a, i) => (
            <span key={a.nav}>
              <button type="button" className="transition-opacity hover:opacity-60" onClick={() => ask(a.say)}>
                {a.nav}
              </button>
              {i < ANSWERS.length - 1 && <span>,&nbsp;</span>}
            </span>
          ))}
        </div>
        <a href={REPO_URL} className="hidden text-[23px] text-black underline underline-offset-2 transition-opacity hover:opacity-60 md:block">
          See the code
        </a>
        <button type="button" className="flex flex-col gap-[5px] p-2 md:hidden" aria-label={menu ? "Close menu" : "Open menu"} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <span className={`h-[2px] w-6 bg-black transition-transform duration-300 ${menu ? "translate-y-[7px] rotate-45" : ""}`} />
          <span className={`h-[2px] w-6 bg-black transition-opacity duration-300 ${menu ? "opacity-0" : ""}`} />
          <span className={`h-[2px] w-6 bg-black transition-transform duration-300 ${menu ? "-translate-y-[7px] -rotate-45" : ""}`} />
        </button>
      </nav>

      <div
        className="fixed inset-0 z-[9] flex flex-col justify-center gap-8 bg-[#f2f0eb]/95 px-8 backdrop-blur-sm transition-opacity duration-300 md:hidden"
        style={{ opacity: menu ? 1 : 0, pointerEvents: menu ? "auto" : "none" }}
        inert={!menu}
      >
        {ANSWERS.map((a) => (
          <button key={a.nav} type="button" className="text-left text-[32px] text-black" onClick={() => ask(a.say)}>
            {a.nav}
          </button>
        ))}
        <a href={REPO_URL} className="text-[32px] text-black underline underline-offset-2">
          See the code
        </a>
      </div>

      <main id="top" className="relative z-[1] flex h-screen flex-col justify-end overflow-hidden px-5 pb-12 sm:px-8 md:justify-center md:px-10 md:pb-0">
        <div className="relative z-10 max-w-xl">
          <p className="pointer-events-none mb-5 select-none sm:mb-6" aria-hidden="true" style={{ fontSize: "clamp(18px, 4vw, 26px)", lineHeight: 1.3, color: "#000", filter: "blur(4px)" }}>
            Hey there, meet TARS,
            <br />a chief of staff for founders with ADHD
          </p>
          <h1 className="sr-only">TARS, a chief of staff for founders with ADHD</h1>

          <p className="mb-5 text-black sm:mb-6" aria-live="polite" style={{ fontSize: "clamp(18px, 4vw, 26px)", lineHeight: 1.35, minHeight: 54 }}>
            <span className="sr-only">{line.text}</span>
            <span aria-hidden="true">
              {displayed}
              {!done && <span className="cursor ml-[2px] inline-block h-[1.1em] w-[2px] bg-black align-middle" />}
            </span>
          </p>

          <div className="rise flex flex-wrap gap-y-1" data-shown={shown || undefined}>
            <div className="flex flex-wrap gap-y-1">
              {ANSWERS.map((a) => (
                <button key={a.ask} type="button" className={`${pill} border-black/20 bg-[#f2f0eb] text-black hover:bg-black hover:text-white`} onClick={() => ask(a.say)}>
                  {a.ask}
                </button>
              ))}
              <button type="button" className={`${pill} gap-2 border-[#1f3460] bg-transparent text-[#1f3460] hover:bg-[#1f3460] hover:text-white sm:gap-3`} onClick={() => void copy()}>
                <span>
                  {copied ? "Copied: " : "Source: "}
                  <span className="underline underline-offset-1">{REPO}</span>
                </span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M8.5 3.5V2.5a1.5 1.5 0 0 0-1.5-1.5H2.5A1.5 1.5 0 0 0 1 2.5V7a1.5 1.5 0 0 0 1.5 1.5h1" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
