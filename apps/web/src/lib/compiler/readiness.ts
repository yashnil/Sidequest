import 'server-only';
import {
  missingProviderSwitches,
  openProvidersEnabled,
} from '../providers/switches';

/**
 * WHICH PROVIDER SET RUNS — ANSWERABLE WITHOUT IMPORTING ANY OF THEM.
 *
 * This used to live in `compiler/providers.ts`, which builds the provider set.
 * Reading an environment variable is harmless; importing the module that builds
 * Nominatim, Valhalla, Overture and the research model in order to *ask about*
 * them is not. The render-purity audit found the consequence: the plan page had
 * the entire live stack in its transitive import graph purely because it wanted
 * to render "compiling new destinations is switched off in this build".
 *
 * Nothing was ever called from there. But "nothing is called today" is a
 * property of the current control flow rather than of the build, and it is one
 * refactor away from being false — which is exactly the class of defect an
 * architecture test exists to make impossible rather than unlikely.
 *
 *   open     the live open-licensed stack — Nominatim for the name, the Overture
 *            place backbone for what is there, Valhalla for travel times,
 *            Anthropic for research. Public Overpass is a fallback rather than a
 *            requirement.
 *   fixture  deterministic synthetic worlds, built through the *same* backbone.
 *            What the end-to-end suite runs on.
 *   off      no compilation at all, which is the honest default.
 *
 * An unrecognised value falls through to **off**. These reach volunteer-run
 * services and a billed model, and a typo should cost nothing.
 */
export type CompilerProviderChoice = 'open' | 'fixture' | 'off';

export function compilerProviderChoice(): CompilerProviderChoice {
  const configured = process.env.SIDEQUEST_COMPILER_PROVIDER?.trim().toLowerCase();
  if (configured === 'fixture' || configured === 'off') return configured;
  if (configured === 'open') return 'open';
  // Nothing configured: infer from the provider switches, so a developer who
  // turned those on does not also have to remember this one.
  return openProvidersEnabled() ? 'open' : 'off';
}

export interface ProviderReadiness {
  ready: boolean;
  choice: CompilerProviderChoice;
  message: string;
}

export function providerReadiness(): ProviderReadiness {
  const choice = compilerProviderChoice();
  if (choice === 'fixture') {
    return { ready: true, choice, message: 'Running against deterministic test data.' };
  }
  if (choice === 'open') {
    if (openProvidersEnabled()) {
      return { ready: true, choice, message: 'Running against the open map data stack.' };
    }
    return {
      ready: false,
      choice,
      // Names the switches, never a value. A developer needs to know which is
      // missing; nobody needs to see what is in it.
      message: `This build is missing: ${missingProviderSwitches().join(', ')}.`,
    };
  }
  return {
    ready: false,
    choice,
    message:
      'Compiling new destinations is switched off in this build, so only regions we already hold can be planned.',
  };
}
