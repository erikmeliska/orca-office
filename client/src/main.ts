import './style.css';
import { Net } from './net';
import { DesktopNotifier } from './notify';
import { store, loadProfile, loadSettings } from './state';
import { PlayerController, groundAt } from './player';
import { Hands } from './world/hands';
import { Confetti } from './world/confetti';
import { djFrame } from './dnb';
import { $ } from './ui/dom';
import { elevatorPanelOpen } from './ui/elevator';
import { onModelsProgress, preloadModels } from './world/models';
import { loadingScreen } from './ui/loading';
import { createCtx } from './core/ctx';
import type { Parts } from './core/parts';
import { createScene, fitWindow, installSky, makeRenderer, noWebGL } from './core/scene';
import { createWorlds } from './core/worlds';
import { frameLoop, installLoop } from './core/loop';
import { installPlace } from './core/place';
import { installYou, makeMe, makeSmoke, makeSound } from './core/you';
import { installTravel } from './core/travel';
import { installArrival } from './core/arrival';
import { installMaps } from './core/maps';
import { installHintBar } from './core/hintbar';
import { installKeyboard, installKeyGuards } from './input/keyboard';
import { installFocus } from './input/focus';
import { installPointer } from './input/pointer';
import { installArcade } from './features/arcade';
import { installBar } from './features/bar';
import { installBarGames } from './features/bargames';
import { installBasketball } from './features/basketball';
import { installBoards } from './features/boards';
import { installBookshelf } from './features/bookshelf';
import { installCabinet } from './features/cabinet';
import { installChat } from './features/chat';
import { installClimbing } from './features/climbing';
import { installCoffee } from './features/coffee';
import { installDog } from './features/dog';
import { installEmotes } from './features/emotes';
import { installGong } from './features/gong';
import { installGallery, installHanging } from './features/hanging';
import { installHerald } from './features/herald';
import { installHud } from './features/hud';
import { installNeedsYou } from './features/needsyou';
import { installHandoffs } from './features/handoffs';
import { installProjectBoard } from './ui/project';
import { installPalette } from './features/palette';
import { installPeers } from './features/peers';
import { installRooftop } from './features/rooftop';
import { installSeating } from './features/seating';
import { installSmoke } from './features/smoke';
import { installLamplight } from './features/lamplight';
import { installTelescope } from './features/telescope';
import { installTv } from './features/tv';
import { installWaiting } from './features/waiting';
import { installWalking } from './features/walking';
import { installWorkerActions } from './features/workers/actions';
import { installWorkerViews } from './features/workers/views';

// The loading screen stays up until there's an office to see (see boot and whoami at the end).
const loading = loadingScreen(onModelsProgress);
// The models made in Blender, loaded before the world they're in is built (see world/models.ts).
await preloadModels();

// ---- The context every part of the office plugs into (see core/context.ts) ----------------------------
// Built before the parts it hands out, which are there by the time anything asks for them. Every part
// below goes into `parts` as it's made; one reaches another's only when something happens, so the
// order here is the order they register in: messages, keys, ticks, store topics and listeners run in
// that order, and it's kept on purpose.
const parts = {} as Parts;
const { ctx, core } = createCtx(parts);
// The office's own parts of each frame, before anything else's.
installLoop(ctx, core, parts);

// ---- Renderer & scene ---------------------------------------------------------------------------
const canvas = $('scene') as HTMLCanvasElement;
parts.stage = createScene(canvas, makeRenderer(canvas) ?? (await noWebGL()));
parts.worlds = createWorlds(ctx);
installSky(ctx);

// ---- The install list ---------------------------------------------------------------------------
parts.boards = installBoards(ctx);
parts.gallery = installGallery(ctx);
// Onto whatever you're walking on: the office's floor and furniture, or the roof's.
parts.confetti = new Confetti((x, z, y) => groundAt(ctx.player.colliders, x, z, y, false));
ctx.scene.add(parts.confetti.mesh);
parts.tv = installTv(ctx);
parts.arcade = installArcade(ctx);
parts.rooftop = installRooftop(ctx, { ambient: parts.stage.ambient, hemi: parts.stage.hemi });

// You, and how you talk to the office.
parts.net = new Net(() => store.profile, () => parts.arrival.whereNow());
parts.me = makeMe(ctx);
parts.settings = loadSettings();
parts.player = new PlayerController(ctx.camera, canvas, ctx.office.colliders);
parts.telescope = installTelescope(ctx, { clearTarget: () => parts.pointer.clearTarget(), backToGame: () => parts.focus.backToGame() });
installKeyGuards(ctx, parts);
parts.place = installPlace(ctx, core, parts);
// Everyone arrives by elevator (the welcome says exactly where).
parts.place.placeInCar();
parts.player.view = parts.settings.view;
parts.hands = new Hands(store.profile.color, parts.me.skinColor);
parts.you = installYou(ctx);
parts.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
({ smoke: parts.smoke, puff: parts.puff } = makeSmoke(ctx));
parts.sound = makeSound(parts.settings);

parts.dog = installDog(ctx);
parts.cabinet = installCabinet(ctx, { openTerminal: (id) => parts.waiting.openWorkerTerminal(id) });
parts.notifier = new DesktopNotifier(() => parts.settings.notify, (id) => parts.waiting.answerWorker(id));
const standUp = () => parts.seating.standUp();
const stopWalking = () => parts.walking.stopWalkingTo();
const personOf = (id: string) => parts.peers.remotes.get(id)?.person;
const reach = () => parts.you.reach();
parts.bargames = installBarGames(ctx, { roof: parts.rooftop.roof, standUp, stopWalking, personOf });
parts.hanging = installHanging(ctx, { gallery: parts.gallery, reach });
parts.climbing = installClimbing(ctx, { travel: (floorId, how, at) => parts.travel.travel(floorId, how, at), standUp, stopWalking });

parts.travel = installTravel(ctx, core, parts);
parts.arrival = installArrival(ctx, core, parts);
parts.maps = installMaps(ctx, core, parts);
parts.peers = installPeers(ctx, core, parts);
parts.walking = installWalking(ctx, core, parts);
parts.views = installWorkerViews(ctx, core, parts);
parts.actions = installWorkerActions(ctx, core, parts);
parts.waiting = installWaiting(ctx, core, parts);
parts.needsYou = installNeedsYou(ctx, parts);
// M4: deliveries between agents (#34) and the project room's board (#29, #30).
const handoffs = installHandoffs(ctx);
installProjectBoard(ctx.net);
installPalette(ctx, parts);
parts.bookshelf = installBookshelf(ctx);
installHerald(ctx, parts);

parts.bar = installBar(ctx, { roof: parts.rooftop.roof, djAt: parts.rooftop.djAt, reach });
parts.coffee = installCoffee(ctx);
parts.smoking = installSmoke(ctx);
installLamplight(ctx, parts);
parts.hoops = installBasketball(ctx, { remotes: parts.peers.remotes, reach });
parts.seating = installSeating(ctx, { arcade: parts.arcade, showBar: parts.bar.showBar, usable: () => parts.pointer.usable() });
installGong(ctx, { burstOver: parts.views.burstOver, workerViews: parts.views.workerViews, court: () => parts.worlds.court(), idleAgents: () => parts.worlds.idleAgents() });

parts.hintbar = installHintBar(ctx, core, parts);
parts.emotes = installEmotes(ctx, { personOf });
installKeyboard(ctx, parts);
parts.focus = installFocus(ctx, core, parts);
parts.pointer = installPointer(ctx, core, parts);
installChat(ctx);
parts.hud = installHud(ctx, core, parts);

// ---- Main loop ---------------------------------------------------------------------------------------
fitWindow(ctx);
const frame = frameLoop(ctx, loading);

// ---- Boot ------------------------------------------------------------------------------------------
function boot() {
  parts.net.connect();
  requestAnimationFrame(frame);
}

// No sign-in and no character select first (orca-office is one person's office, design.md #1): in with
// the look you saved last time, or a random one, which ⚙️ Settings → Your character changes.
{
  const saved = loadProfile();
  if (saved?.look) store.profile = { ...saved, look: saved.look };
  else if (saved) Object.assign(store.profile, { name: saved.name, color: saved.color });
  store.emit('me');
  parts.you.showMyProfile(store.profile);
  boot();
  // In as soon as the floor you're on is here with its dog, so the dog doesn't pop in after.
  const welcomed = new Promise<void>((resolve) => {
    const off = store.on('floor', () => {
      off();
      resolve();
    });
  });
  loading.until([
    { say: 'Knocking on the door', done: welcomed },
    { say: 'Fetching the dog', done: parts.dog.firstReady },
  ]);
}

// Debug handle for quick checks from the console / headless screenshots.
const { worlds, views, rooftop, bar, coffee, bargames, hanging, climbing, emotes, hoops } = parts;
(window as unknown as Record<string, unknown>).__office = { handoffs, world: () => worlds.world(), court: () => worlds.court(), sendoffs: views.sendoffs, jail: views.jail, adrift: views.adrift, plan: worlds.plan, applyMap: parts.maps.applyMap, roof: rooftop.roof, booze: bar.booze, dj: () => djFrame(rooftop.djAt()), store, player: parts.player, caffeine: coffee.caffeine, camera: ctx.camera, arcade: parts.arcade, cabinet: parts.cabinet, workerViews: views.workerViews, departures: views.departures, arrivals: views.arrivals, scene: ctx.scene, net: parts.net, renderer: ctx.renderer, hands: parts.hands, me: parts.me, remotes: parts.peers.remotes, settings: parts.settings, gallery: parts.gallery, hanger: hanging.hanger, office: ctx.office, ride: parts.travel.ride, switchFloor: parts.travel.switchFloor, climber: climbing.climber, thrower: bargames.thrower, elevatorPanelOpen, confetti: parts.confetti, dog: parts.dog, sky: ctx.sky, holiday: parts.stage.holiday, emoteWheel: emotes.emoteWheel, emote: emotes.emote, ball: hoops.ball };
(window as unknown as Record<string, unknown>).__sound = parts.sound;
(window as unknown as Record<string, unknown>).__notify = parts.notifier;
