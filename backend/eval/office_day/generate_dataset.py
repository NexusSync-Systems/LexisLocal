#!/usr/bin/env python3
"""
generate_dataset.py — syntetická data pro simulaci „den v kanceláři“ (backend/scripts/office_day.js).

Vše je SMYŠLENÉ: osoby, firmy, sp. zn., částky. Žádná data klientů. Generuje se deterministicky
(--seed), takže stejný seed = stejná sada a výsledky běhů jde srovnávat.

Výstup (--out, výchozí ./dataset):
  manifest.json            kancelář, spisy, dokumenty s OČEKÁVANÝMI hodnotami (sp. zn., lhůta, doručení)
  spisy_<advokat>.csv       import stávajících spisů (každý advokát importuje své)
  knowhow/*.txt             interní postupy kanceláře → znalostní báze rešeršníka
  onboarding/*              dokumenty nahrané při zavedení (digitalizace stávajících spisů)
  den/*                     písemnosti, které přijdou během dne (.zfo se sestaví až v office_day.js)

  python3 backend/eval/office_day/generate_dataset.py --out /tmp/ds --spisy 150 --onboarding 250 --den 150
  tar -czf backend/eval/office_day/dataset-v1.tar.gz -C /tmp/ds .

Závislosti (jen pro generování, ne pro běh testu): reportlab, python-docx, Pillow, font DejaVu Serif.
"""
import argparse, datetime as dt, json, os, random, unicodedata

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from docx import Document
from docx.shared import Pt
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_DIR = os.environ.get('DEJAVU_DIR', '/usr/share/fonts/truetype/dejavu')
pdfmetrics.registerFont(TTFont('DV', os.path.join(FONT_DIR, 'DejaVuSerif.ttf')))
pdfmetrics.registerFont(TTFont('DVB', os.path.join(FONT_DIR, 'DejaVuSerif-Bold.ttf')))

DEN = dt.date(2026, 11, 3)  # simulovaný pracovní den (úterý)
SVATKY = {dt.date(2026, 10, 28), dt.date(2026, 11, 17), dt.date(2026, 12, 24), dt.date(2026, 12, 25), dt.date(2026, 12, 26)}

KANCELAR = {
    'nazev': 'Advokátní kancelář Malá, Veselý & partneři (SIMULACE)',
    'uzivatele': [
        {'key': 'mala', 'name': 'JUDr. Petra Malá', 'role': 'advokat'},
        {'key': 'vesely', 'name': 'Mgr. Tomáš Veselý', 'role': 'advokat'},
        {'key': 'dvorakova', 'name': 'Mgr. Jana Dvořáková', 'role': 'advokat'},
        {'key': 'krejci', 'name': 'Mgr. Ondřej Krejčí', 'role': 'koncipient'},
        {'key': 'simkova', 'name': 'Lenka Šimková', 'role': 'asistent'},
    ]
}
ADVOKATI = [u for u in KANCELAR['uzivatele'] if u['role'] == 'advokat']

# Větší kancelář pro zátěžový den (--velka): 6 advokátů, 2 koncipienti, 2 asistentky.
KANCELAR_VELKA = {
    'nazev': 'Advokátní kancelář Malá, Veselý & partneři (SIMULACE – velká)',
    'uzivatele': KANCELAR['uzivatele'][:3] + [
        {'key': 'horak', 'name': 'JUDr. Martin Horák', 'role': 'advokat'},
        {'key': 'kralova', 'name': 'Mgr. Tereza Králová', 'role': 'advokat'},
        {'key': 'benes', 'name': 'Mgr. David Beneš', 'role': 'advokat'},
        KANCELAR['uzivatele'][3],
        {'key': 'pokorna', 'name': 'Mgr. Hana Pokorná', 'role': 'koncipient'},
        KANCELAR['uzivatele'][4],
        {'key': 'urbanova', 'name': 'Alena Urbanová', 'role': 'asistent'},
    ]
}

JMENA_M = ['Jan', 'Petr', 'Pavel', 'Martin', 'Tomáš', 'Jiří', 'Lukáš', 'Jakub', 'David', 'Michal', 'Ondřej', 'Radek', 'Vojtěch', 'Filip', 'Aleš']
JMENA_Z = ['Eva', 'Jana', 'Lucie', 'Petra', 'Kateřina', 'Markéta', 'Veronika', 'Tereza', 'Hana', 'Zuzana', 'Alena', 'Monika', 'Barbora', 'Iveta']
PRIJMENI = [('Novák', 'Nováková'), ('Svoboda', 'Svobodová'), ('Dvořák', 'Dvořáková'), ('Černý', 'Černá'), ('Procházka', 'Procházková'),
            ('Kučera', 'Kučerová'), ('Horák', 'Horáková'), ('Němec', 'Němcová'), ('Pokorný', 'Pokorná'), ('Marek', 'Marková'),
            ('Pospíšil', 'Pospíšilová'), ('Hájek', 'Hájková'), ('Jelínek', 'Jelínková'), ('Král', 'Králová'), ('Růžička', 'Růžičková'),
            ('Beneš', 'Benešová'), ('Fiala', 'Fialová'), ('Sedláček', 'Sedláčková'), ('Doležal', 'Doležalová'), ('Zeman', 'Zemanová'),
            ('Kolář', 'Kolářová'), ('Navrátil', 'Navrátilová'), ('Čermák', 'Čermáková'), ('Urban', 'Urbanová'), ('Vaněk', 'Vaňková')]
FIRMY_A = ['Alfa', 'Beta', 'Orion', 'Vega', 'Sirius', 'Lyra', 'Kappa', 'Delta', 'Polaris', 'Atlas', 'Nova', 'Terra', 'Aqua', 'Merkur', 'Iris']
FIRMY_B = ['Stavby', 'Logistika', 'Software', 'Reality', 'Trade', 'Energie', 'Servis', 'Pekárna', 'Autodíly', 'Projekce', 'Média', 'Farma']
FORMY = ['s.r.o.', 'a.s.', 's.r.o.', 's.r.o.']
SOUDY = [('Okresní soud v Jihlavě', 'Jihlavě'), ('Městský soud v Brně', 'Brně'), ('Okresní soud Brno-venkov', 'Brně'),
         ('Okresní soud v Třebíči', 'Třebíči'), ('Obvodní soud pro Prahu 4', 'Praze'), ('Okresní soud ve Žďáru nad Sázavou', 'Žďáru nad Sázavou'),
         ('Okresní soud v Havlíčkově Brodě', 'Havlíčkově Brodě')]
ULICE = ['Masarykova', 'Husova', 'Palackého', 'Nádražní', 'Školní', 'Lidická', 'Komenského', 'Polní', 'Lipová', 'Zahradní']
MESTA = ['Jihlava', 'Brno', 'Třebíč', 'Žďár nad Sázavou', 'Havlíčkův Brod', 'Praha 4', 'Pelhřimov', 'Velké Meziříčí']

AGENDY = [
    # (agenda, senát, název věci, předmět pro texty)
    ('obcanske', 'C', 'zaplacení kupní ceny', 'zaplacení dlužné kupní ceny za dodané zboží'),
    ('obcanske', 'C', 'náhrada škody', 'náhradu škody vzniklé vytopením bytu'),
    ('obcanske', 'C', 'vyklizení bytu', 'vyklizení bytu po skončení nájmu'),
    ('obcanske', 'C', 'vrácení zálohy', 'vrácení zálohy na dílo, které nebylo provedeno'),
    ('obchodni', 'Cm', 'smluvní pokuta', 'zaplacení smluvní pokuty z rámcové smlouvy'),
    ('obchodni', 'Cm', 'zaplacení ceny díla', 'zaplacení ceny díla podle smlouvy o dílo'),
    ('pracovni', 'C', 'neplatnost výpovědi', 'určení neplatnosti výpovědi z pracovního poměru'),
    ('rodinne', 'P a Nc', 'úprava péče', 'úpravu poměrů nezletilého dítěte'),
    ('obcanske', 'C', 'bezdůvodné obohacení', 'vydání bezdůvodného obohacení'),
    ('obcanske', 'EC', 'zaplacení částky', 'zaplacení částky z neuhrazených faktur'),
]

# Rizikové klauzule do smluv ke kontrole: (text článku, regex, který má kontrolor zmínit)
RIZIKA = [
    ('Objednatel uhradí zálohu ve výši 100 % ceny díla do 3 dnů od podpisu smlouvy.', r'z[aá]loh|100\s?%'),
    ('Zhotovitel je oprávněn jednostranně zvýšit cenu díla až o 30 % bez souhlasu objednatele.', r'30\s?%|jednostrann'),
    ('Všechny spory z této smlouvy rozhodne rozhodce jmenovaný výhradně zhotovitelem.', r'rozhod[čc]|rozhodce'),
    ('Za prodlení objednatele s úhradou náleží zhotoviteli smluvní pokuta 1 % denně z dlužné částky bez omezení.', r'1\s?%|smluvn[ií] pokut'),
    ('Smlouva se automaticky prodlužuje vždy o 10 let, nevypoví-li ji objednatel nejpozději 2 roky před uplynutím doby.', r'prodlu|10 let|automatick'),
    ('Odpovědnost zhotovitele za vady díla se vylučuje v plném rozsahu.', r'vylu[čc]|odpov[eě]dnost za vad|pr[áa]v\S* z vadn\S* pln[ěe]n'),
    ('Objednatel se vzdává práva odstoupit od smlouvy z jakéhokoli důvodu.', r'odstoup|vzd[aá]v'),
    ('Záruční doba činí 3 měsíce a vady je nutné oznámit do 2 dnů od jejich vzniku.', r'z[aá]ru[čc]|3 m[eě]s|2 dn'),
]


def ascii_slug(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').lower().replace(' ', '-')


def kratce(strana):
    """Krátké označení do názvu spisu: u firmy první slovo, u osoby příjmení."""
    return strana.split(' ')[0] if strana.endswith(('s.r.o.', 'a.s.')) else strana.split(' ')[-1]


def d_cz(d):
    return f'{d.day}. {d.month}. {d.year}'


def workday_exact(start, days):
    """Konec lhůty, pokud nepadne na víkend/svátek (jinak None = přesné datum nekontrolujeme)."""
    end = start + dt.timedelta(days=days)
    return end.isoformat() if end.weekday() < 5 and end not in SVATKY else None


class Gen:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.used_spzn = set()

    def osoba(self):
        if self.r.random() < 0.5:
            p = self.r.choice(PRIJMENI); return f'{self.r.choice(JMENA_M)} {p[0]}'
        p = self.r.choice(PRIJMENI); return f'{self.r.choice(JMENA_Z)} {p[1]}'

    def firma(self):
        return f'{self.r.choice(FIRMY_A)} {self.r.choice(FIRMY_B)} {self.r.choice(FORMY)}'

    def strana(self):
        return self.firma() if self.r.random() < 0.45 else self.osoba()

    def adresa(self):
        return f'{self.r.choice(ULICE)} {self.r.randint(1, 120)}, {self.r.choice(MESTA)}'

    def spzn(self, senat):
        while True:
            s = f'{self.r.randint(3, 59)} {senat} {self.r.randint(10, 899)}/{self.r.choice([2025, 2026, 2026])}'
            if s not in self.used_spzn:
                self.used_spzn.add(s); return s


# ─── výstupní formáty ──────────────────────────────────────────────────────────
def write_pdf(path, lines, title=None):
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle(title or os.path.basename(path)); c.setAuthor('SIMULACE'); c.setCreator('LexisLocal office_day')
    w, h = A4; y = h - 60
    for ln in lines:
        bold = ln.startswith('**')
        t = ln.strip('*')
        c.setFont('DVB' if bold else 'DV', 13 if bold else 10.5)
        # zalomení dlouhých řádků
        words, cur = t.split(' '), ''
        chunks = []
        for wd in words:
            if pdfmetrics.stringWidth((cur + ' ' + wd).strip(), 'DV', 10.5) > w - 120:
                chunks.append(cur); cur = wd
            else:
                cur = (cur + ' ' + wd).strip()
        chunks.append(cur)
        for ch in chunks:
            if y < 60:
                c.showPage(); y = h - 60; c.setFont('DVB' if bold else 'DV', 13 if bold else 10.5)
            c.drawString(60, y, ch); y -= 16 if bold else 14
        if not t:
            y -= 6
    c.save()


def write_docx(path, title, paras):
    d = Document()
    st = d.styles['Normal']; st.font.name = 'Calibri'; st.font.size = Pt(11)
    d.add_heading(title, level=1)
    for p in paras:
        if p.startswith('## '):
            d.add_heading(p[3:], level=2)
        else:
            d.add_paragraph(p)
    d.core_properties.author = 'SIMULACE'
    d.save(path)


def write_png(path, lines, r):
    W, H = 1240, 1754 // 2 + 120
    img = Image.new('L', (W, H), 250)
    dr = ImageDraw.Draw(img)
    f = ImageFont.truetype(os.path.join(FONT_DIR, 'DejaVuSerif.ttf'), 30)
    fb = ImageFont.truetype(os.path.join(FONT_DIR, 'DejaVuSerif-Bold.ttf'), 34)
    y = 70
    for ln in lines:
        bold = ln.startswith('**'); t = ln.strip('*')
        dr.text((80, y), t, fill=20, font=fb if bold else f); y += 50 if bold else 44
    # lehký „sken“: šum + mírné natočení
    for _ in range(700):
        dr.point((r.randint(0, W - 1), r.randint(0, H - 1)), fill=r.randint(120, 200))
    img = img.rotate(r.uniform(-0.8, 0.8), fillcolor=250, expand=False)
    img.save(path, optimize=True)


# ─── texty písemností ─────────────────────────────────────────────────────────
def hlavicka_soudu(s):
    return [f'**{s["soud"]}**', f'Sp. zn. {s["spisZn"]}', '']


def rozsudek(g, s, doruceno):
    castka = g.r.randint(12, 480) * 1000
    vyhrano = g.r.random() < 0.6
    return hlavicka_soudu(s) + [
        '**ROZSUDEK**', '**JMÉNEM REPUBLIKY**', '',
        f'{s["soud"]} rozhodl samosoudcem Mgr. {g.osoba()} ve věci',
        f'žalobce: {s["zalobce"]}, bytem/sídlem {g.adresa()},',
        f'proti žalovanému: {s["zalovany"]}, bytem/sídlem {g.adresa()},',
        f'o {s["predmet"]},', '', 'takto:', '',
        (f'I. Žalovaný je povinen zaplatit žalobci částku {castka:,} Kč s úrokem z prodlení do 3 dnů od právní moci rozsudku.'.replace(',', ' ')
         if vyhrano else 'I. Žaloba se zamítá.'),
        'II. Žádný z účastníků nemá právo na náhradu nákladů řízení.', '',
        '**Odůvodnění:**',
        f'Žalobce se žalobou domáhal {s["predmet"]}. Soud provedl dokazování listinami a výslechem účastníků '
        f'a dospěl k závěru, že žaloba {"je důvodná" if vyhrano else "není důvodná"}.', '',
        '**Poučení:**',
        'Proti tomuto rozsudku lze podat odvolání do 15 dnů ode dne doručení písemného vyhotovení '
        f'ke Krajskému soudu prostřednictvím soudu, který rozhodl.', '',
        f'V {s["soud_mesto"]} dne {d_cz(doruceno - dt.timedelta(days=g.r.randint(4, 12)))}',
        '', f'Doručeno: {d_cz(doruceno)}'
    ]


def vyzva(g, s, doruceno):
    co = g.r.choice(['doplnil žalobu o označení důkazů k prokázání tvrzené výše nároku',
                     'zaplatil soudní poplatek ve výši 2 000 Kč', 'předložil plnou moc pro zástupce',
                     'sdělil, zda souhlasí s rozhodnutím věci bez nařízení jednání'])
    return hlavicka_soudu(s) + ['**USNESENÍ**', '', f'{s["soud"]} ve věci žalobce {s["zalobce"]} proti žalovanému {s["zalovany"]} o {s["predmet"]}',
        '', f'vyzývá žalobce, aby do 10 dnů ode dne doručení tohoto usnesení {co}.', '',
        'Nebude-li výzvě vyhověno, soud řízení zastaví (§ 43 odst. 2 o. s. ř.).', '',
        '**Poučení:** Proti tomuto usnesení není odvolání přípustné.', '', f'Doručeno: {d_cz(doruceno)}']


def platebni_rozkaz(g, s, doruceno):
    castka = g.r.randint(8, 250) * 1000
    return hlavicka_soudu(s) + ['**PLATEBNÍ ROZKAZ**', '',
        f'Žalovaný {s["zalovany"]} je povinen zaplatit žalobci {s["zalobce"]} částku {castka:,} Kč'.replace(',', ' ') + ' a náhradu nákladů řízení do 15 dnů od doručení.',
        '', '**Poučení:**', 'Proti tomuto platebnímu rozkazu lze podat odpor do 15 dnů ode dne jeho doručení u soudu, který jej vydal.',
        '', f'Doručeno: {d_cz(doruceno)}']


def predvolani(g, s, doruceno, den_jednani):
    return hlavicka_soudu(s) + ['**PŘEDVOLÁNÍ K JEDNÁNÍ**', '',
        f'Ve věci žalobce {s["zalobce"]} proti žalovanému {s["zalovany"]} o {s["predmet"]} se nařizuje jednání',
        f'na den {d_cz(den_jednani)} v 9:30 hodin, jednací síň č. {g.r.randint(1, 30)}.', '',
        'Účastníci se vyzývají, aby nejpozději při jednání předložili všechny listinné důkazy.', '', f'Doručeno: {d_cz(doruceno)}']


def zaloba(g, s):
    castka = g.r.randint(15, 600) * 1000
    return [f'**{s["soud"]}**', '', f'Žalobce: {s["zalobce"]}, {g.adresa()}', f'zastoupen: {s["advokat"]}, advokát',
        f'Žalovaný: {s["zalovany"]}, {g.adresa()}', '', f'**Žaloba o {s["predmet"]}**', f'Sp. zn. {s["spisZn"]}', '',
        f'I. Žalobce a žalovaný uzavřeli dne {d_cz(DEN - dt.timedelta(days=g.r.randint(200, 900)))} smlouvu.',
        f'II. Žalovaný své povinnosti nesplnil a dluží žalobci {castka:,} Kč.'.replace(',', ' '),
        'III. Žalobce žalovaného vyzval k plnění předžalobní výzvou, avšak bezvýsledně.', '',
        f'Žalobce navrhuje, aby soud vydal rozsudek, kterým žalovanému uloží zaplatit {castka:,} Kč s příslušenstvím.'.replace(',', ' '),
        '', f'V Jihlavě dne {d_cz(DEN - dt.timedelta(days=g.r.randint(40, 200)))}']


def plna_moc(g, s):
    return ['**PLNÁ MOC**', '', f'Já, {s["klient"]}, zmocňuji advokáta {s["advokat"]} k zastupování ve všech úkonech',
        f've věci {s["nazev"]} vedené u {s["soud"]} pod sp. zn. {s["spisZn"]}.', '', f'V Jihlavě dne {d_cz(DEN - dt.timedelta(days=g.r.randint(60, 400)))}',
        '', '……………………', s['klient']]


def email_klienta(g, s, den):
    otazka = g.r.choice([
        'Chtěla bych se zeptat, jak to vypadá s mým případem a jestli už soud něco rozhodl.',
        'Protistrana mi včera volala a nabízí mimosoudní dohodu. Mám na to přistoupit?',
        'Dostal jsem dopis od soudu, ale nerozumím mu. Do kdy musím něco udělat?',
        'Kolik mě bude stát odvolání, kdyby to soud nerozhodl v můj prospěch?',
        'Můžeme se příští týden sejít v kanceláři? Hodil by se mi čtvrtek odpoledne.',
    ])
    return (f'Od: {ascii_slug(s["klient"]).replace("-", ".")}@example.cz\nKomu: kancelar@example.cz\nPředmět: {s["nazev"]} – dotaz ({s["spisZn"]})\n'
            f'Datum: {d_cz(den)}\n\nDobrý den,\n\n{otazka}\nJde o věc sp. zn. {s["spisZn"]} u {s["soud"]}.\n\nDěkuji,\n{s["klient"]}\n')


def smlouva(g, s, rizika):
    sml = g.r.choice(['Smlouva o dílo', 'Rámcová smlouva o dodávkách', 'Smlouva o poskytování služeb'])
    paras = [f'uzavřená mezi: {s["klient"]} (objednatel) a {s["zalovany"]} (zhotovitel)', '']
    clanky = ['Předmět smlouvy: zhotovitel se zavazuje provést pro objednatele dílo podle přílohy č. 1.',
              f'Cena díla činí {g.r.randint(80, 900) * 1000:,} Kč bez DPH.'.replace(',', ' '),
              f'Termín dokončení díla je {d_cz(DEN + dt.timedelta(days=g.r.randint(30, 200)))}.',
              'Objednatel poskytne zhotoviteli nezbytnou součinnost.',
              'Zhotovitel provede dílo s odbornou péčí a v souladu s technickými normami.',
              'Smluvní strany se zavazují zachovávat mlčenlivost o obchodních podmínkách.',
              'Smlouvu lze měnit jen písemnými dodatky.']
    vlozit = [x[0] for x in rizika]
    allc = clanky[:]
    for v in vlozit:
        allc.insert(g.r.randint(2, len(allc)), v)
    for i, c in enumerate(allc, 1):
        paras += [f'## Článek {i}', c]
    paras += ['', 'Smluvní strany prohlašují, že si smlouvu přečetly a souhlasí s jejím obsahem.']
    return sml, paras


def knowhow():
    return {
        'postup_podani.txt': 'Interní postup kanceláře (SIMULACE): Každé podání k soudu schvaluje odpovědný advokát spisu. '
            'Podání k odvolacímu soudu navíc kontroluje druhý advokát (čtyři oči). Lhůty zapisuje asistentka do lhůtníku '
            'nejpozději v den doručení; koncipient připraví koncept nejpozději 3 pracovní dny před koncem lhůty.',
        'sazebnik.txt': 'Sazebník kanceláře (SIMULACE): hodinová sazba advokáta 2 400 Kč, koncipienta 1 400 Kč. '
            'Paušál za sepsání odvolání 9 000 Kč. Úkony podle advokátního tarifu jen u přiznaných nákladů řízení.',
        'komunikace_klienti.txt': 'Pravidla komunikace s klienty (SIMULACE): odpověď klientovi do 2 pracovních dnů. '
            'E-mail s právním hodnocením odesílá jen advokát, nikdy automaticky. AI koncept vždy zkontroluje člověk.',
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='dataset'); ap.add_argument('--seed', type=int, default=20261103)
    ap.add_argument('--spisy', type=int, default=150); ap.add_argument('--onboarding', type=int, default=250)
    ap.add_argument('--den', type=int, default=150); ap.add_argument('--nove-spisy', type=int, default=8)
    ap.add_argument('--velka', action='store_true', help='větší kancelář (10 lidí) pro zátěžový den')
    a = ap.parse_args()
    global KANCELAR, ADVOKATI
    if a.velka:
        KANCELAR = KANCELAR_VELKA
        ADVOKATI = [u for u in KANCELAR['uzivatele'] if u['role'] == 'advokat']
    g = Gen(a.seed)
    out = a.out
    for d in ('onboarding', 'den', 'knowhow'):
        os.makedirs(os.path.join(out, d), exist_ok=True)

    # spisy
    spisy = []
    for i in range(a.spisy):
        ag = g.r.choice(AGENDY)
        soud, mesto = g.r.choice(SOUDY)
        adv = ADVOKATI[i % len(ADVOKATI)] if i < a.spisy * 0.9 else g.r.choice(ADVOKATI)
        klient = g.strana(); proti = g.strana()
        zal_je_klient = g.r.random() < 0.7
        s = {'id': f'S{i + 1:03d}', 'spisZn': g.spzn(ag[1]), 'agenda': ag[0], 'nazev': f'{kratce(klient)} – {ag[2]}',
             'predmet': ag[3], 'klient': klient, 'protistrana': proti, 'soud': soud, 'soud_mesto': mesto,
             'advokat': adv['name'], 'advokatKey': adv['key'],
             'zalobce': klient if zal_je_klient else proti, 'zalovany': proti if zal_je_klient else klient}
        spisy.append(s)
    for adv in ADVOKATI:
        rows = [s for s in spisy if s['advokatKey'] == adv['key']]
        with open(os.path.join(out, f'spisy_{adv["key"]}.csv'), 'w', encoding='utf-8-sig') as f:
            f.write('Spisová značka;Název;Klient;Protistrana;Soud;Odpovědný advokát;Agenda\n')
            for s in rows:
                f.write(';'.join([s['spisZn'], s['nazev'], s['klient'], s['protistrana'], s['soud'], s['advokat'], s['agenda']]) + '\n')

    docs = []

    def add(phase, fname, kind, s, **exp):
        docs.append({'file': f'{phase}/{fname}', 'phase': phase, 'kind': kind, 'spisId': s['id'] if s else None,
                     'spisZn': s['spisZn'] if s else None, 'expect': exp})

    # onboarding: digitalizace stávajících spisů
    kinds_on = [('zaloba', 0.3), ('plna_moc', 0.2), ('rozsudek_stary', 0.15), ('smlouva', 0.15), ('email', 0.15), ('sken', 0.05)]
    for n in range(a.onboarding):
        s = spisy[n % len(spisy)] if n < len(spisy) else g.r.choice(spisy)
        k = g.r.choices([k for k, _ in kinds_on], [w for _, w in kinds_on])[0]
        slug = f'{n + 1:03d}_{ascii_slug(s["spisZn"]).replace("/", "-")}'
        if k == 'zaloba':
            fn = f'{slug}_zaloba.pdf'; write_pdf(os.path.join(out, 'onboarding', fn), zaloba(g, s)); add('onboarding', fn, k, s, caseNumber=s['spisZn'])
        elif k == 'plna_moc':
            fn = f'{slug}_plna_moc.pdf'; write_pdf(os.path.join(out, 'onboarding', fn), plna_moc(g, s)); add('onboarding', fn, k, s, caseNumber=s['spisZn'])
        elif k == 'rozsudek_stary':
            dor = DEN - dt.timedelta(days=g.r.randint(60, 300))
            fn = f'{slug}_rozsudek.pdf'; write_pdf(os.path.join(out, 'onboarding', fn), rozsudek(g, s, dor))
            add('onboarding', fn, k, s, caseNumber=s['spisZn'], deadlineDays=15, deliveryDate=dor.isoformat())
        elif k == 'smlouva':
            rz = g.r.sample(RIZIKA, 3); title, paras = smlouva(g, s, rz)
            fn = f'{slug}_smlouva.docx'; write_docx(os.path.join(out, 'onboarding', fn), title, paras)
            add('onboarding', fn, k, s, rizika=[x[1] for x in rz])
        elif k == 'email':
            fn = f'{slug}_email.txt'
            open(os.path.join(out, 'onboarding', fn), 'w', encoding='utf-8').write(email_klienta(g, s, DEN - dt.timedelta(days=g.r.randint(5, 90))))
            add('onboarding', fn, k, s, caseNumber=s['spisZn'])
        else:
            dor = DEN - dt.timedelta(days=g.r.randint(30, 200))
            fn = f'{slug}_sken.png'; write_png(os.path.join(out, 'onboarding', fn), vyzva(g, s, dor), g.r)
            add('onboarding', fn, k, s, caseNumber=s['spisZn'], deadlineDays=10, deliveryDate=dor.isoformat(), ocr=True)

    # nové věci během dne (asistentka založí spis po kontrole střetu zájmů)
    nove = []
    # klíč bez právní formy: „Alfa Logistika s.r.o.“ a „Alfa Logistika a.s.“ prověrka střetu správně bere jako tutéž firmu
    def _klic(x):
        return x.replace(' s.r.o.', '').replace(' a.s.', '').strip().lower()
    jmena = {_klic(x) for s in spisy for x in (s['klient'], s['protistrana'])}

    def nova_strana():
        # nová věc bez střetu: jméno, které ve spisech kanceláře není (jinak by šlo o skutečný střet)
        for _ in range(400):
            x = g.strana()
            if _klic(x) not in jmena:
                jmena.add(_klic(x)); return x
        raise RuntimeError('málo jmen pro nové strany')
    for i in range(a.nove_spisy):
        ag = g.r.choice(AGENDY); soud, mesto = g.r.choice(SOUDY); adv = g.r.choice(ADVOKATI)
        klient = nova_strana()
        # 2 nové věci: protistranou je stávající klient kanceláře → střet zájmů
        konflikt = i < 2
        proti = g.r.choice(spisy)['klient'] if konflikt else nova_strana()
        s = {'id': f'N{i + 1:02d}', 'spisZn': g.spzn(ag[1]), 'agenda': ag[0], 'nazev': f'{kratce(klient)} – {ag[2]}', 'predmet': ag[3],
             'klient': klient, 'protistrana': proti, 'soud': soud, 'soud_mesto': mesto, 'advokat': adv['name'], 'advokatKey': adv['key'],
             'zalobce': klient, 'zalovany': proti, 'expectConflict': konflikt,
             't': 60 + round((i + 0.5) * 360 / a.nove_spisy)}  # minuta dne, kdy asistentka věc zakládá
        nove.append(s)

    # den: příchozí písemnosti (časy v minutách od 8:00, ranní špička z datové schránky)
    def cas():
        return min(510, max(0, int(g.r.choices([g.r.gauss(45, 25), g.r.gauss(240, 120)], [0.45, 0.55])[0])))
    kinds_den = [('zfo_rozsudek', 0.14), ('zfo_vyzva', 0.12), ('zfo_platebni', 0.06), ('zfo_predvolani', 0.06),
                 ('rozsudek', 0.08), ('email', 0.24), ('smlouva', 0.12), ('sken', 0.08), ('nova_vec', 0.04), ('neznama', 0.06)]
    for n in range(a.den):
        k = g.r.choices([k for k, _ in kinds_den], [w for _, w in kinds_den])[0]
        s = g.r.choice(spisy)
        t = cas()
        slug = f'd{n + 1:03d}'
        dor = DEN - dt.timedelta(days=g.r.choice([0, 0, 1, 1, 2, 4, 6]))
        if k.startswith('zfo_'):
            sub = k[4:]
            body = {'rozsudek': lambda: rozsudek(g, s, dor), 'vyzva': lambda: vyzva(g, s, dor), 'platebni': lambda: platebni_rozkaz(g, s, dor),
                    'predvolani': lambda: predvolani(g, s, dor, DEN + dt.timedelta(days=g.r.randint(20, 60)))}[sub]()
            body = [l for l in body if not l.startswith('Doručeno:')]  # u datové zprávy platí doručení z ISDS
            fn = f'{slug}_{sub}.zfo.txt'
            open(os.path.join(out, 'den', fn), 'w', encoding='utf-8').write('\n'.join(x.strip('*') for x in body) + '\n')
            days = {'rozsudek': 15, 'vyzva': 10, 'platebni': 15, 'predvolani': None}[sub]
            # přihlášení do schránky ráno v den doručení (doručení přihlášením)
            exp = dict(caseNumber=s['spisZn'], deliveryDate=dor.isoformat())
            if days:
                exp.update(deadlineDays=days, deadlineDate=workday_exact(dor, days))
            docs.append({'file': f'den/{fn}', 'phase': 'den', 'kind': k, 'spisId': s['id'], 'spisZn': s['spisZn'], 't': t,
                         'zfo': {'sender': s['soud'], 'annotation': f'{sub} {s["spisZn"]}', 'attachment': f'{sub}_{ascii_slug(s["spisZn"]).replace("/", "-")}.txt',
                                 'deliveryTime': f'{(dor - dt.timedelta(days=1)).isoformat()}T15:00:00+01:00', 'acceptanceTime': f'{dor.isoformat()}T07:40:00+01:00'},
                         'expect': exp})
            continue
        if k == 'rozsudek':
            fn = f'{slug}_rozsudek.pdf'; write_pdf(os.path.join(out, 'den', fn), rozsudek(g, s, dor))
            exp = dict(caseNumber=s['spisZn'], deadlineDays=15, deliveryDate=dor.isoformat(), deadlineDate=workday_exact(dor, 15))
        elif k == 'email':
            fn = f'{slug}_email.txt'; open(os.path.join(out, 'den', fn), 'w', encoding='utf-8').write(email_klienta(g, s, DEN)); exp = dict(caseNumber=s['spisZn'])
        elif k == 'smlouva':
            rz = g.r.sample(RIZIKA, g.r.randint(3, 4)); title, paras = smlouva(g, s, rz)
            fn = f'{slug}_smlouva.docx'; write_docx(os.path.join(out, 'den', fn), title, paras); exp = dict(rizika=[x[1] for x in rz])
        elif k == 'sken':
            fn = f'{slug}_sken.png'; write_png(os.path.join(out, 'den', fn), vyzva(g, s, dor), g.r)
            exp = dict(caseNumber=s['spisZn'], deadlineDays=10, deliveryDate=dor.isoformat(), deadlineDate=workday_exact(dor, 10), ocr=True)
        elif k == 'nova_vec':
            # žaloba podaná za klienta nové věci — přijde až po založení spisu (a jen u věcí bez střetu)
            s = g.r.choice([x for x in nove if not x['expectConflict']])
            t = min(505, s['t'] + g.r.randint(20, 120))
            fn = f'{slug}_zaloba_nova.pdf'; write_pdf(os.path.join(out, 'den', fn), zaloba(g, s)); exp = dict(caseNumber=s['spisZn'])
        else:  # písemnost k věci, kterou kancelář nemá → automaticky vznikne spis bez vlastníka
            ag = g.r.choice(AGENDY); soud, mesto = g.r.choice(SOUDY)
            # strany cizí věci nesmí kolidovat s klienty kanceláře (jinak by v systému vznikl skutečný střet zájmů)
            cizi = {'id': None, 'spisZn': g.spzn(ag[1]), 'soud': soud, 'soud_mesto': mesto, 'zalobce': nova_strana(), 'zalovany': nova_strana(), 'predmet': ag[3]}
            fn = f'{slug}_neznama_vec.pdf'; write_pdf(os.path.join(out, 'den', fn), vyzva(g, cizi, dor))
            docs.append({'file': f'den/{fn}', 'phase': 'den', 'kind': 'neznama', 'spisId': None, 'spisZn': cizi['spisZn'], 't': t,
                         'expect': dict(caseNumber=cizi['spisZn'], deadlineDays=10, autoSpis=True)})
            continue
        docs.append({'file': f'den/{fn}', 'phase': 'den', 'kind': k, 'spisId': s['id'], 'spisZn': s['spisZn'], 't': t, 'expect': exp})

    for fn, txt in knowhow().items():
        open(os.path.join(out, 'knowhow', fn), 'w', encoding='utf-8').write(txt + '\n')

    manifest = {'_info': 'SYNTETICKÁ data pro office_day.js — vše smyšlené. Generátor: backend/eval/office_day/generate_dataset.py',
                'seed': a.seed, 'den': DEN.isoformat(), 'kancelar': KANCELAR, 'spisy': spisy, 'noveSpisy': nove, 'dokumenty': docs,
                'rizikaRegex': {r[0]: r[1] for r in RIZIKA}}
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    by = {}
    for d in docs:
        by[d['kind']] = by.get(d['kind'], 0) + 1
    print(f'spisy {len(spisy)} + nové {len(nove)}, dokumenty {len(docs)}: {by}')


if __name__ == '__main__':
    main()
