// Each family's mark is `public/models/<family>.svg` (monochrome, from LobeHub icons, MIT).
import type { ModelFamily } from '@gyblos/protocol/model-family';

export {
  modelFamily,
  modelLab,
  type ModelFamily,
} from '@gyblos/protocol/model-family';
export const modelMarkUrl = (family: ModelFamily) => `/models/${family}.svg`;
