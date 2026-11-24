# UX roadmap: čo chýba a čo by sa hodilo

Prieskum z 2026-11-25. Má tri zdroje:
- hands-on UX audit kancelárie na falošných dátach (40 screenshotov, desktop aj mobil),
- prieskum podobných nástrojov (agent-office, Pixel Agents, Claude Office Visualizer, agent-deck, Vibe Kanban, Nudgy, agentsd/Stream Deck, AgentsRoom, ccusage, GitHub mission control),
- mapa toho, čo Orca vie a kancelária zatiaľ nepoužíva.

Hlavná myšlienka: kancelária je dobrá na „čo sa deje“, ale slabá na „čo mám spraviť ja“. Tri najväčšie medzery:
- „needs you“ vidno len na poschodí, kde práve si,
- predvolený pohľad ukazuje lobby, nie stoly,
- veľa miesta zaberajú hry a multiplayer z agent-office, ktoré sólo dohľadu nepomáhajú.

Effort: S = do pol dňa, M = deň, L = viac dní.

## Vlna A: rýchle opravy s veľkým efektom

| # | Čo | Prečo | Effort |
|---|----|-------|--------|
| A1 | **„Needs you“ pre celú budovu.** Pill a banner ukážu napr. „2 need you · 1 here, 1 on blog-ai“ a N skočí aj na iné poschodie, zoradené od najdlhšie čakajúceho. | Dnes na Staff poschodí alebo v project roome čakajúci agent zo stránky zmizne. | M |
| A2 | **Otvorené decision gates patria do needs-you fronty** (N, banner, pill). | Rozhodnutie je presne to, čo čaká na teba. | S |
| A3 | **Počet čakajúcich v titulku karty a vo favicone,** napr. „(2) orca-office“. Desktop notifikácia sa spustí pre celú budovu, nie len pre aktuálne poschodie. | Uvidíš to aj zo zatvoreného alebo skrytého okna. | S |
| A4 | **Počet čakajúcich v status bare Orca.** Položku „Office“ plugin už má, stačí do nej dať „🔴 2“. | Signál priamo v Orca, kde aj tak sedíš. | S |
| A5 | **Workers panel a hlavička terminálu ukazujú worktree, vetvu a otázku agenta,** nie vymyslené mená (Sol, Pia). | Myslíš vo vetvách, nie v menách. | S |
| A6 | **⌘K a Workers panel pre celú budovu,** zoskupené podľa poschodí. Oprava úloh Runu, ktoré sa dnes tvária ako „PR #1“. | Hľadanie dnes nenájde agenta na inom poschodí. | M |
| A7 | **Bug: kláves L (linky pri stole)** sa ukazuje v nápovede, ale nefunguje (`interaction.ts`). | Rozbitý sľub. | S |
| A8 | **Neaktuálne dáta vyzerajú živo.** Keď bridge alebo Orca vypadne, svet zošedne a ukáže „posledná aktualizácia pred 2 min“. | Dnes pri výpadku vidíš staré „working“ a „needs you“. | S |
| A9 | **Predvolená kamera = prehľad zhora šikmo,** jeden kláves prepne na mapu zhora (2D pôdorys so stavmi). | Prvý pohľad je dnes lobby, automat a gauč, nie stoly. | M |
| A10 | **Nápoveda pre dohľad:** 6 riadkov (N, ⌘K, E, O, R, M), zvyšok zbalený. Pri prvom spustení hint „Stlač N“. | Dnes má nápoveda 35 riadkov a začína kávou a hrami. | S |
| A11 | **Prepínač „Fun“, štandardne vypnutý:** skryje „Press T to chat“, TOGETHER, bar, automat, šípky, gong a emoty a schová ich z menu a ⌘K. | Šetrí miesto aj pozornosť. Psa nechávam, ten je súčasť kancelárie. | S–M |
| A12 | **Mobil = 2D zoznam** (needs you, working, done) s odpoveďou a „Open in Orca“. `live.html` opraviť alebo zmazať. | 3D na telefóne sa nedá ovládať a `live.html` ukazuje nezmysly. | M |
| A13 | **Reduced motion naozaj:** bez konfety, tanca a DJ svetiel. Kratší štart a loader bez „Fetching the dog“. | Prístupnosť a pokoj pri sústredení. | S |
| A14 | **Klávesnica:** Tab presúva fokus, menu otvorí iný kláves. Brány v project roome, ktoré sa tvária ako tlačidlá, buď ožijú, alebo nebudú vyzerať ako tlačidlá. | Ovládanie bez myši. | S |

## Vlna B: pohodlná každodenná práca

| # | Čo | Odkiaľ dáta | Effort |
|---|----|-------------|--------|
| B1 | **Odpovedať priamo z bannera** jedným riadkom, bez otvárania terminálu. Pri povolení (permission prompt) tlačidlá Áno / Vždy / Nie. | `terminal.sendText` / `orca terminal send`; pri workeroch `orchestration deny`. | M |
| B2 | **Rôzne signály** pre otázku, povolenie, hotovo a chybu: iná bublina a iný zvuk. Voliteľne hlasom: „blog-ai čaká na povolenie“. | Stav z Orca a hooky (inšpirácia Pixel Agents, disler TTS). | M |
| B3 | **Command Center:** prekryvná vrstva so stĺpcami Needs you / Working / Done / Ended pre celú budovu. Klik skočí k stolu. | Model, ktorý bridge už má. | M |
| B4 | **Review room:** hotoví agenti s PR stoja vo fronte pri stole „review“. Každý ukazuje farbu CI, veľkosť diffu a čas čakania. | `linkedPR` / `orca reference`, CI z Orca GitHub cache alebo `gh`. | M–L |
| B5 | **Detektor zaseknutia:** agent bez udalostí N minút alebo „working“ celý deň (blog-ai 1d) zaspí za stolom a dostane sivý odznak „stuck?“. | Časy zo stavov a hookov. | S |
| B6 | **Kontext na stole:** kôš sa plní, ako sa zapĺňa kontextové okno, a pri kompaktovaní sa vysype. Pribudne počítadlo nástrojov od posledného kompaktovania. | Hooky (Claude Code) a session usage. | M |
| B7 | **Monitor na stole s bežiacim dev serverom:** „Open preview :3000“. | `orca ports`. | S |
| B8 | **Fulltextové hľadanie v sedeniach z ⌘K:** „kde som riešil webhook?“ → skok k stolu alebo do Orca. | `orca search`. | M |
| B9 | **Automatizácie ako nástenné hodiny:** ďalší beh, posledný výsledok, „spustiť teraz“. | `orca automations list/runs/run`. | M |
| B10 | **Kanban stav worktree** (`workspaceStatus`: in-progress, review, …) ako farba stola a ako stĺpec v B3. | `orca worktree list`. | S |
| B11 | **„Upratať“:** smetiak v kancelárii ukáže, čo by upratovacie pravidlá Orca odstránili. Mazanie len po potvrdení. | `orca workspace cleanup preview/run`. | M |
| B12 | **Spotreba ako elektromer:** limity providerov (5 h a týždeň), čas do resetu a odhad podľa tempa míňania. | Rieši sa v samostatnom PR (Claude `get_usage`, Codex `rate_limits`, ccusage style). | M |
| B13 | **Steering pri stole:** prerušiť (Esc), „zhrň stav“, pokračovať, resume starej session. | `terminal.sendText`, `agent.resume`. | M |

## Vlna C: divoké, ale užitočné nápady

| # | Čo | Prečo to nie je len hračka |
|---|----|---------------------------|
| C1 | **Fronta pri tvojich dverách.** Čakajúci agenti fyzicky stoja v rade pred tvojou kanceláriou, zoradení podľa času čakania. | Dĺžku backlogu vidíš z druhého konca miestnosti. |
| C2 | **Čiary konfliktov.** Medzi stolmi, ktorých worktree menia tie isté súbory, svieti čiara a jej hrúbka ukazuje rozsah prekryvu. | Varuje pred merge konfliktom skôr, než vznikne. Toto zoznamy nevedia. |
| C3 | **Budova ako rozpočet.** Svetlá poschodia slabnú, ako repo míňa limit, a v lobby je elektromer s odhadom. | Spotreba sa číta ako elektrická sieť, bez čísel. |
| C4 | **Spätné prehratie dňa.** Pretočíš časovú os a vidíš, kto kedy čakal a kde sa zasekol. | Vizuálne retro. Opakujúce sa zaseknutia vidno, z listu hotových úloh nie. |
| C5 | **Súperiace stoly.** Rovnakú úlohu dostanú dvaja agenti (Claude vs. Codex), pracujú vedľa seba a na konci sa ich diffy porovnajú. | Lepší výsledok aj porovnanie modelov (inšpirácia Vibe Kanban). |
| C6 | **Vzdialenosť = relevancia.** Stoly, ktoré ťa nedávno potrebovali alebo majú PR, sú bližšie ku kamere a nečinné stoly sú tlmené na okraji. | Rozloženie sa samo zoradí podľa toho, čo je dôležité. |
| C7 | **Fyzické tlačidlá.** Stream Deck alebo menu bar s počtom čakajúcich a Approve/Deny. | Na dohľad netreba okno. |

## Odporúčané poradie

1. **Vlna A celá ako M6.** Kancelária sa tým zmení z „pekné na pozeranie“ na „pracovný nástroj“. Väčšina úloh je S, spolu zhruba 3–4 dni agentskej práce.
2. **Z vlny B najprv** B1 (odpoveď z bannera), B5 (zaseknutie), B3 (Command Center), B10 a B7 (lacné a viditeľné), potom B4 (review room).
3. **Z vlny C** C2 (konflikty) a C1 (fronta pri dverách). Majú najlepší pomer užitočnosti a toho, čo zoznam neponúkne.
