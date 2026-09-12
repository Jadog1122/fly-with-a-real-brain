// Entry point that re-exports the pet's logic for the offline behaviour harness in
// bake/15_pet_tune.mjs.  Nothing browser-specific: the canvas drawing is never called.
export { LiveBrain } from './sim'
export { computeDrive, foragingDrive, Saccades, STIMULI } from './sensors'
export { MotorDecoder } from './motor'
export { World } from './world'
