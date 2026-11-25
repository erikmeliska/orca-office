/**
 * The HUD: a few buttons on the top bar, everything else in the ☰ menu (Tab), with H for the controls
 * and F to hang a picture; the project in the corner (click it for the floors); Settings, and your
 * character.
 */
import { ROOF } from '@orca-office/shared/office/rooftop';
import type { Ctx } from '../../core/context';
import type { CoreState } from '../../core/ctx';
import { builtFloors } from '../../core/floors';
import type { Parts } from '../../core/parts';
import { pillLabel } from '../../waiting-all';
import { saveSettings, store } from '../../state';
import { openCharacter } from '../../ui/character';
import { $ } from '../../ui/dom';
import { toggleFloorMenu } from '../../ui/floormenu';
import { openHelp } from '../../ui/hud';
import { mountHud } from '../../ui/menu';
import { openServices } from '../../ui/services';
import { openSettings, type SettingsPane } from '../../ui/settings';
import { openUpgrade } from '../../ui/upgrade';
import { describeSky } from '../../world/sky';

export type HudParts = Pick<Parts, 'worlds' | 'place' | 'travel' | 'you' | 'actions' | 'waiting' | 'bookshelf' | 'hanging' | 'notifier'>;

/** Listens for clicks on the HUD and the project, registers what the HUD follows (see mountHud), and binds Tab, H and F. */
export function installHud(ctx: Ctx, core: CoreState, parts: HudParts) {
  const { net, settings, player, sound } = ctx;
  const { inOffice } = parts.worlds;
  const { travel, waiting, hanging } = parts;

  // Buttons must not keep focus, or Space (jump) would click them again.
  $('hud').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (btn) setTimeout(() => btn.blur(), 0);
  });
  // The project in the corner is the floor you're on; click it for the list of floors to go to.
  $('project').addEventListener('click', () => {
    if (!store.floor) return travel.showElevator();
    toggleFloorMenu($('project'), { go: travel.switchFloor, indoors: () => (!inOffice() && !core.upTop) || parts.place.indoors(), elevator: travel.showElevator, roof: inOffice() ? () => travel.ride(ROOF) : null });
  });

  // ---- The HUD: a few buttons on the top bar, everything else in the ☰ menu ----------------------------
  // Everyone waiting for you in the building (M6 A1), this floor's done ones after them.
  const waitingNow = () => waiting.stops();
  const needsNow = () => waitingNow().some((s) => s.needs);
  const hud = mountHud(
    [
      { id: 'services', icon: '🌐', label: 'Services', section: 'Open', count: () => store.services.items.length, title: () => 'Dev servers running in this floor’s worktrees', run: () => openServices() },
      { id: 'search', icon: '🔎', label: 'Search', section: 'Open', key: '/', title: () => 'Search the chat and every terminal', run: waiting.showSearch },
      // The office has its bookshelf for them; a map of its own may not.
      { id: 'docs', icon: '📚', label: 'Docs', section: 'Open', shown: () => !inOffice(), title: () => 'Read the project’s docs', run: parts.bookshelf.showBookshelf },
      { id: 'elevator', icon: '🛗', label: () => (inOffice() ? 'Elevator' : 'Floors'), section: 'Open', count: () => store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0), title: () => (inOffice() ? 'Ride to another project' : 'Go to another project, or add one'), run: travel.showElevator },
      { id: 'roof', icon: '🍸', label: 'Rooftop bar', section: 'Open', shown: () => !core.upTop && inOffice() && builtFloors().length > 0, title: () => 'Ride the elevator up to the roof: a DJ, drinks and the city', run: () => travel.ride(ROOF) },
      { id: 'decor', icon: '🖼️', label: () => (hanging.hanger.active ? 'Stop hanging the picture' : 'Hang a picture'), section: 'Together', key: 'F', shown: () => inOffice(), on: () => hanging.hanger.active, status: () => hanging.hanger.active, run: () => (hanging.hanger.active ? hanging.hanger.cancel() : hanging.startHanging()) },
      { id: 'settings', icon: '⚙️', label: 'Settings', section: 'Office', run: showSettings },
      { id: 'help', icon: '❓', label: 'Controls', section: 'Office', key: 'H', run: openHelp },
      {
        id: 'upgrade',
        icon: '⬆️',
        label: () => (store.upgrade.phase === 'building' ? 'Upgrading…' : store.upgrade.latest ? 'Update the office' : 'Upgrade the office'),
        section: 'Office',
        shown: () => store.upgrade.available,
        // A new version, or one being built, gets a place on the top bar until it's in.
        status: () => !!store.upgrade.latest || store.upgrade.phase === 'building',
        chip: () => (store.upgrade.phase === 'building' ? 'Upgrading…' : 'Update'),
        tone: () => (store.upgrade.latest && store.upgrade.phase !== 'building' ? 'primary' : undefined),
        title: () => (store.upgrade.latest ? `New version: ${store.upgrade.latest.subject}` : 'Upgrade the office'),
        run: () => openUpgrade(net),
      },
      // Up on the top bar while workers wait on someone (N does the same), next to the Workers button.
      {
        id: 'waiting',
        icon: () => (needsNow() ? '🙋' : '✅'),
        label: 'Next one waiting for you',
        section: 'Open',
        key: 'N',
        shown: () => waitingNow().length > 0,
        status: () => waitingNow().length > 0,
        chip: () => pillLabel(waitingNow(), store.floor).replace(/^(🙋|✅) /, ''),
        on: () => !needsNow(),
        tone: () => (needsNow() ? 'danger' : undefined),
        title: () => 'Go to the next one waiting for you, on any floor: the ones that need you first, longest first (N)',
        run: waiting.goToNextWaiting,
      },
    ],
    settings,
    () => saveSettings(settings),
  );
  ctx.keys.bind({
    code: 'Tab',
    preventDefault: true,
    run: () => {
      hud.toggleMenu();
    },
  });
  ctx.keys.bind({
    code: 'KeyH',
    run: () => {
      openHelp();
    },
  });
  ctx.keys.bind({
    code: 'KeyF',
    run: () => {
      hanging.startHanging();
    },
  });
  function showSettings(pane?: SettingsPane) {
    openSettings(
      net,
      settings,
      (s) => {
        Object.assign(settings, s);
        saveSettings(settings);
        player.setView(settings.view);
        sound.setVolume(settings.volume, settings.muted);
        sound.setMusicVolume(settings.music, settings.musicMuted);
      },
      editProfile,
      sound,
      parts.notifier,
      store.sky ? { now: describeSky(store.sky, store.officeNow()), live: !!store.sky.city } : undefined,
      pane,
    );
  }

  function editProfile() {
    openCharacter(false, (p) => {
      parts.you.showMyProfile(p);
      net.send({ t: 'profile', name: p.name, color: p.color, look: p.look });
    });
  }

  return { hud, showSettings, editProfile };
}
