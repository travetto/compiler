import { CustomTransformers } from 'typescript';
import { requireAppFiles, findAppFiles } from '@travetto/base';

export class TransformerManager {

  transformers: CustomTransformers = {};

  constructor(private cwd: string) { }

  init() {
    const transformers: { [key: string]: any } = {};
    let i = 2;

    for (const trns of requireAppFiles('.ts', x => /transformer[.].*[.]ts$/.test(x))) {
      for (const key of Object.keys(trns)) {
        const item = trns[key];
        if (!transformers[item.phase]) {
          transformers[item.phase] = [];
        }
        item.priority = item.priority === undefined ? ++i : item.priority;
        item.name = item.name || key;
        transformers[item.phase].push(item);
      }
    }
    for (const key of Object.keys(transformers)) {
      transformers[key] = (transformers[key] as any[]).sort((a, b) => a.priority - b.priority).map(x => x.transformer);
    }
    this.transformers = transformers;
  }
}