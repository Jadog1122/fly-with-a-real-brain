"""Build the kids' manual PDF.  Plain fonts only - no emoji, the built-in
Helvetica has no glyphs for them and they come out as black boxes."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Image,
                                PageBreak, Table, TableStyle, KeepTogether)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping
import os, matplotlib

# Embed a real font family.  The built-in Helvetica is not embedded in the file, so
# whether <b> actually looks bold depends on what the reader substitutes - on this
# machine it substituted a regular weight and the bold text came out flat.
_TTF = os.path.join(os.path.dirname(matplotlib.__file__), 'mpl-data', 'fonts', 'ttf')
for _name, _file in [('Body', 'DejaVuSans.ttf'), ('Body-Bold', 'DejaVuSans-Bold.ttf'),
                     ('Body-Italic', 'DejaVuSans-Oblique.ttf'),
                     ('Body-BoldItalic', 'DejaVuSans-BoldOblique.ttf'),
                     ('Mono', 'DejaVuSansMono.ttf')]:
    pdfmetrics.registerFont(TTFont(_name, os.path.join(_TTF, _file)))
for _b, _i, _n in [(0, 0, 'Body'), (1, 0, 'Body-Bold'),
                   (0, 1, 'Body-Italic'), (1, 1, 'Body-BoldItalic')]:
    addMapping('Body', _b, _i, _n)
addMapping('Mono', 0, 0, 'Mono')

OUT = Path('manual/fly-brain-manual.pdf')
FIGS = Path('manual/figs')
INK = colors.HexColor('#1e2a38')
SOFT = colors.HexColor('#5d7185')
BLUE = colors.HexColor('#2f6fb0')
AMBER = colors.HexColor('#c98a10')
ROSE = colors.HexColor('#d4365c')
PALE = colors.HexColor('#eef4fa')
PALEW = colors.HexColor('#fff6e3')

def cell(txt, bold=False, mono=False, colour=None, size=11):
    st = ParagraphStyle('cell', fontName='Body-Bold' if bold else ('Mono' if mono else 'Body'),
                        fontSize=size if not mono else size - .8, leading=size + 4,
                        textColor=colour or colors.HexColor('#1e2a38'))
    return Paragraph(txt, st)


S = {
    'title': ParagraphStyle('t', fontName='Body-Bold', fontSize=30, leading=35,
                            textColor=INK, spaceAfter=4),
    'sub': ParagraphStyle('s', fontName='Body', fontSize=14.5, leading=20,
                          textColor=SOFT, spaceAfter=16),
    'h': ParagraphStyle('h', fontName='Body-Bold', fontSize=19, leading=24,
                        textColor=BLUE, spaceBefore=10, spaceAfter=8),
    'h2': ParagraphStyle('h2', fontName='Body-Bold', fontSize=13.5, leading=18,
                         textColor=INK, spaceBefore=9, spaceAfter=4),
    'p': ParagraphStyle('p', fontName='Body', fontSize=12.6, leading=19.5,
                        textColor=INK, spaceAfter=9),
    'big': ParagraphStyle('big', fontName='Body-Bold', fontSize=15.5, leading=22,
                          textColor=INK, spaceAfter=10),
    'cap': ParagraphStyle('c', fontName='Body-Italic', fontSize=10.5, leading=14,
                          textColor=SOFT, spaceAfter=13, alignment=1),
    'note': ParagraphStyle('n', fontName='Body', fontSize=11.8, leading=17.5,
                           textColor=INK),
}


def fig(name, width=165 * mm):
    from PIL import Image as PImage
    p = FIGS / name
    w, h = PImage.open(p).size
    return Image(str(p), width=width, height=width * h / w)


def box(flow, bg=PALE, border=colors.HexColor('#cfe0ef')):
    t = Table([[flow]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg),
        ('BOX', (0, 0), (-1, -1), 0.9, border),
        ('LEFTPADDING', (0, 0), (-1, -1), 11), ('RIGHTPADDING', (0, 0), (-1, -1), 11),
        ('TOPPADDING', (0, 0), (-1, -1), 9), ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
    ]))
    return t


def P(txt, st='p'):
    return Paragraph(txt, S[st])


story = []
A = story.append

# ------------------------------------------------------------------- cover
A(Spacer(1, 24 * mm))
A(P('The fly in your computer', 'title'))
A(P('A guide to poking a real brain and seeing what happens', 'sub'))
A(fig('fig1_map.png'))
A(P('This is not a drawing. Every dot is a real brain cell from one real fruit fly.', 'cap'))
A(Spacer(1, 6 * mm))
A(box(P('<b>Everything in this guide is real</b>, except two things, and page 8 '
        'tells you exactly what they are.', 'note'), PALEW, colors.HexColor('#e8d3a0')))
A(PageBreak())

# ------------------------------------------------------------- what is this
A(P('1. What is this thing?', 'h'))
A(P('Some scientists caught a fruit fly. The kind that buzzes around old bananas.'))
A(P('They took out its brain. It is smaller than the dot on this "i".'))
A(P('Then they sliced it into slices thinner than a hair, took millions of photographs, '
    'and traced <b>every single brain cell</b> and <b>every single wire</b> between them. '
    'It took years and thousands of people.'))
A(Spacer(1, 3 * mm))
A(box(P('<font size=15><b>138,639</b></font> brain cells<br/>'
        '<font size=15><b>15,091,983</b></font> wires joining them up', 'note')))
A(Spacer(1, 5 * mm))
A(P('That map is what your computer is using. It is a copy of one real fly\'s brain, '
    'wire for wire. Nobody invented it or guessed it.'))
A(P('And here is the fun part: a map of a brain is not just a picture. '
    'If you know who is wired to whom, you can <b>switch it on</b>.'))
A(PageBreak())

# ------------------------------------------------------------ how it works
A(P('2. How a brain cell works', 'h'))
A(P('A brain cell can only do one thing. It can <b>shout</b>.'))
A(P('It cannot think. It cannot decide. It just listens to the cells wired into it, '
    'and when enough of them shout at the same moment, it shouts too. '
    'Then it goes quiet for two thousandths of a second, and it is ready again.'))
A(fig('fig3_talk.png', 150 * mm))
A(Spacer(1, 2 * mm))
A(P('That is the whole rule. One rule.'))
A(P('Your computer follows that rule for 45,808 cells at once, '
    '<b>ten thousand times every second</b>. That is roughly how fast the real fly does it too.'))
A(Spacer(1, 3 * mm))
A(box(P('<b>A shout has a proper name: a <i>spike</i>.</b> If you say "spike" to a brain '
        'scientist they will know exactly what you mean.', 'note'), PALEW,
      colors.HexColor('#e8d3a0')))
A(PageBreak())

# -------------------------------------------------------------- why it works
A(P('3. Why does this work?', 'h'))
A(P('This is the best bit, so read it slowly.'))
A(P('<b>We never told the fly what to do.</b>'))
A(P('We only said one thing: <i>"sugar-tasting cells, start shouting."</i> That is all. '
    'Then we sat back and let the one rule do its work.'))
A(fig('fig2_cascade.png'))
A(P('Yellow: the 23 cells we switched on. Blue: cells that ended up shouting because of '
    'them. Stars: the cells that push the tongue out.', 'cap'))
A(P('The shouting spread from cell to cell, along the real wires, and 26 thousandths of '
    'a second later it arrived at the cells that stick the tongue out. '
    'The fly tasted sugar and went for a lick.'))
A(fig('fig4_timeline.png'))
A(Spacer(1, 1 * mm))
A(box(P('Nobody wrote a rule saying "if sugar, then tongue". '
        'It came <b>out of the map</b>. The wiring already knew.', 'note')))
A(PageBreak())

# ------------------------------------------------------- how do we know it is right
A(P('4. How do we know it is not just made up?', 'h'))
A(P('Fair question. Here are two ways to check, and you can do the second one yourself.'))
A(P('Check one: <b>does it do what real flies do?</b>', 'h2'))
A(P('If you touch something sweet to a real fly, it puts its tongue out. Ours does, '
    'in 26 thousandths of a second. If you wave a shadow over a real fly, it jumps. '
    'Ours jumps too, and even faster: 6 thousandths of a second.'))
A(P('Check two: <b>does it also NOT do things?</b>', 'h2'))
A(P('This one matters more, and it is the test most fakes fail.'))
A(P('When our fly tastes sugar, the jumping cells stay quiet. The walking cells stay '
    'quiet. The turning cells stay quiet. <b>Only</b> the tongue cells go off. '
    'Give it something bitter and almost nothing happens at all, because a fly does not '
    'want to eat that.'))
A(Spacer(1, 2 * mm))
A(box(P('If we had cheated and just written "when sugar, wiggle", the fly would react '
        'the same silly way to everything. It does not. Each thing sets off its own '
        'part of the brain, and leaves the rest dark.', 'note')))
A(PageBreak())

# -------------------------------------------------------------------- what to do
A(P('5. What you can do', 'h'))
A(P('There are two pages to play with.'))
A(P('The fly (open <font name="Mono">pet.html</font>)', 'h2'))
A(P('A fly walks around a box. Pick something from the row along the bottom, '
    'then click in the box to put it there. Click it again to take it away. '
    'Watch the bars on the right: those are the fly\'s real brain cells, shouting.'))
A(Spacer(1, 3 * mm))
hdr = [cell('Put this down', bold=True, colour=colors.white),
       cell('What the fly does', bold=True, colour=colors.white),
       cell('The cells', bold=True, colour=colors.white)]
body = [['Sugar', 'Walks onto it and sticks its tongue out', 'MN9'],
        ['Bitter', 'Almost nothing. It is not food.', '(quiet)'],
        ['Looming shadow', 'Jumps away, fast', 'Giant Fiber'],
        ['Geosmin (mouldy smell)', 'Turns away from it', 'DNa01, DNa02'],
        ['Vibration', 'Stops and cleans its antennae', 'aDN1']]
rows = [hdr] + [[cell(a), cell(b), cell(c, mono=True, colour=ROSE)] for a, b, c in body]
t = Table(rows, colWidths=[45 * mm, 76 * mm, 44 * mm])
t.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), BLUE),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, PALE]),
    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cfe0ef')),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
A(t)
A(Spacer(1, 5 * mm))
A(P('Press <b>show</b> next to the word BRAIN and the whole brain appears, with every '
    'shout lighting up as it happens. Leave it open while you drop things in.'))
A(Spacer(1, 4 * mm))
A(P('The explorer (open the other page)', 'h2'))
A(P('This one is a film you can rewind. Click any glowing dot in the brain and watch '
    'the shouting spread in slow motion. Drag the bar at the bottom to go back and '
    'forth. Press <b>Guided tour</b> and it will talk you through the sugar story.'))
A(PageBreak())

# -------------------------------------------------------------------- experiments
A(P('6. Five experiments', 'h'))
A(P('Real scientists guess first, then look. Guessing first is the whole trick: '
    'if you are surprised, you have learned something.'))
for n, (q, how) in enumerate([
    ('Can the fly find food it cannot see?',
     'Put sugar in a far corner and leave it. The fly cannot smell sugar, only taste it, '
     'so it has to bump into it. How long does it take? Does it ever find it?'),
    ('What happens if you offer sugar and bitter at once?',
     'Put them side by side and watch the "Proboscis out" bar. Does the fly still eat?'),
    ('Does the fly get bored of being scared?',
     'Drop a looming shadow and leave it there. Watch the "Escape jump" bar for twenty '
     'seconds. Real animals stop reacting to a thing that never goes away. Does yours?'),
    ('Does a hungry fly behave differently?',
     'Watch the HUNGER bar fill up over a few minutes, then compare how much the fly '
     'walks when it is full and when it is starving.'),
    ('Which is faster, tongue or jump?',
     'In the explorer, play "Sugar GRNs" and look at the time next to MN9. Then play '
     '"LC4 looming detectors" and look at Giant Fiber. Which number is smaller? '
     'Why do you think a fly is built that way?'),
], 1):
    A(KeepTogether([P(f'Experiment {n}: {q}', 'h2'), P(how)]))
A(Spacer(1, 3 * mm))
A(box(P('<b>Tip:</b> the fly does not have a nose for sugar, only a tongue. '
        'That is true of real flies too - they smell the fruit, not the sugar.', 'note'),
      PALEW, colors.HexColor('#e8d3a0')))
A(PageBreak())

# ------------------------------------------------------------- the honest bit
A(P('7. Two things we made up', 'h'))
A(P('A guide that says "everything here is real" and stops there is not being straight '
    'with you. Two things are ours, not the fly\'s.'))
A(P('One: the body is pretend', 'h2'))
A(P('The scientists only mapped the <b>brain</b>. In a real fly, the wires that work the '
    'legs and the wings carry on down into the body, and that part was not mapped. '
    'So our fly\'s brain shouts "GO!" and "TURN LEFT!" into thin air, and we listen to '
    'those shouts and draw a fly that walks and turns.'))
A(P('The shouting is real. The walking is our drawing of it.'))
A(P('Two: we gave it an itch to wander', 'h2'))
A(P('Nothing in the map makes a fly walk about for no reason. Left alone, our fly would '
    'stand still forever, which is a boring pet. So we quietly tickle the "walk" cells, '
    'a bit harder when the fly is hungry.'))
A(P('That is the only thing we added. Everything else - the tongue, the jump, the '
    'turning, the cleaning - comes out of the real wiring.'))
A(Spacer(1, 3 * mm))
A(box(P('Scientists do this all the time, and the rule is simple: '
        '<b>you always say which bits are yours.</b> Now you know which bits are ours.',
        'note')))
A(PageBreak())

# ------------------------------------------------------------------- glossary
A(P('8. Words you now know', 'h'))
gl = [['neuron', 'A brain cell. The shouting kind.'],
      ['spike', 'One shout.'],
      ['synapse', 'A join where one neuron can shout at another. This fly has 15 million.'],
      ['connectome', 'The full map of who is wired to whom. That is what this whole '
                     'thing is built on.'],
      ['simulation', 'Following the rules of a real thing, step by step, to see what '
                     'it would do.'],
      ['millisecond', 'One thousandth of a second. A blink takes about 100 of them. '
                      'The fly gets its tongue out in 26.']]
gl = [[cell(a, bold=True, colour=BLUE, size=11.5), cell(b, size=11.5)] for a, b in gl]
t = Table(gl, colWidths=[36 * mm, 129 * mm])
t.setStyle(TableStyle([
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.white, PALE]),
    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cfe0ef')),
    ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ('LEFTPADDING', (0, 0), (-1, -1), 8),
]))
A(t)
A(Spacer(1, 8 * mm))
A(P('One last thing', 'h2'))
A(P('Nobody on Earth has ever done this with a human brain. Ours has about 600,000 times '
    'more cells than this fly, and no one has mapped them. The fly is the biggest brain '
    'anyone has ever mapped completely.'))
A(P('So when you drop a bit of sugar in that box and watch the tongue come out, you are '
    'looking at something people only worked out how to do very recently.'))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Body', 8.5)
    canvas.setFillColor(SOFT)
    canvas.drawString(22 * mm, 12 * mm, 'The fly in your computer')
    canvas.drawRightString(A4[0] - 22 * mm, 12 * mm, f'page {doc.page}')
    canvas.setStrokeColor(colors.HexColor('#dbe6f0'))
    canvas.line(22 * mm, 15 * mm, A4[0] - 22 * mm, 15 * mm)
    canvas.restoreState()


doc = SimpleDocTemplate(str(OUT), pagesize=A4, title='The fly in your computer',
                        author='built with Claude Code', leftMargin=22 * mm,
                        rightMargin=22 * mm, topMargin=18 * mm, bottomMargin=20 * mm)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f'wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)')
