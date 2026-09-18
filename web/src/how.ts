// The tutorial page. daisyUI's compiled component CSS plus this page's own theme and
// layout - no Tailwind build, no second framework - and the one thing on the page
// that computes anything: the leaky-cup neuron toy.
// Only the components the page actually uses - the full daisyui.css is 1.1 MB
// (101 kB gzipped), which is more stylesheet than this whole project ships
// elsewhere, to style eight things. The package publishes every component as its
// own file precisely so a page can do this.
import 'daisyui/base/reset.css'
import 'daisyui/base/properties.css'
import 'daisyui/base/rootcolor.css'
import 'daisyui/components/button.css'
import 'daisyui/components/badge.css'
import 'daisyui/components/card.css'
import 'daisyui/components/steps.css'
import 'daisyui/components/collapse.css'
import 'daisyui/components/chat.css'
import 'daisyui/components/alert.css'
import './how.css'

// ---------------------------------------------------------------------------------
// Language toggle. The page carries both languages as sibling .zh/.en elements and
// CSS shows one set; a tiny head script picked the start language before first paint
// (saved choice, else the phone's own language). This button just flips and remembers.
const langBtn = document.getElementById('lang-btn')!
function setLang(l: 'zh' | 'en') {
  document.documentElement.dataset.lang = l
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  document.title = l === 'zh' ? '它没有剧本 — 这只苍蝇的原理' : 'It has no script — how the fly works'
  try { localStorage.setItem('fly-lang', l) } catch { /* private mode: the choice just won't stick */ }
}
langBtn.addEventListener('click', () =>
  setLang(document.documentElement.dataset.lang === 'zh' ? 'en' : 'zh'))

// ---------------------------------------------------------------------------------
// The cup IS the lesson: it does exactly what the 45,808 simulated cells do all day.
// Every press adds charge, the leak drains it, crossing the line fires and resets.
// Same rules, one cell, slowed down five-hundred-fold so a thumb can play the input.
const water = document.getElementById('cup-water')!
const cup = water.parentElement!
const btn = document.getElementById('drip-btn')!
const bulb = document.getElementById('bulb')!
const count = document.getElementById('spike-count')!

const THRESHOLD = 86      // the dashed line sits at 14% from the top
const DRIP = 26           // one press, in percent of the cup
const LEAK = 0.55         // fraction lost per second

let level = 0
let spikes = 0
let last = performance.now()

function drip() {
  level += DRIP
  if (level >= THRESHOLD) {
    level = 0
    spikes++
    count.textContent = String(spikes)
    cup.classList.remove('fired')
    bulb.classList.remove('lit')
    void cup.offsetWidth              // restart the one-shot animations
    cup.classList.add('fired')
    bulb.classList.add('lit')
    setTimeout(() => bulb.classList.remove('lit'), 450)
  }
}

btn.addEventListener('pointerdown', e => { e.preventDefault(); drip() })
btn.addEventListener('keydown', e => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); drip() }
})

function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  // exponential leak, like the real membrane: fast when full, gentle when low
  level *= Math.exp(-LEAK * dt)
  if (level < 0.05) level = 0
  water.style.height = `${Math.min(100, (level / THRESHOLD) * 86)}%`
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
