import * as webpack from 'webpack';
import { Plugin } from 'webpack';

export { default as Azure } from './storage/azure';

/**
 * A tiny progress plugin which logs each progress event on a new line
 */
export function Progress() {
  // XXX: using `any` here until https://github.com/DefinitelyTyped/DefinitelyTyped/pull/22936 is published
  const handler: any = (progress: any, message: any, moduleProgress: any, activeModules: any, moduleName: any) => {
    /**
     * Calculate a time prefix (similar to what gulp does)
     */
    function getTimePrefix() {
      const date = new Date();
      const hours = `0${ date.getHours() }`.slice( -2 );
      const minutes = `0${ date.getMinutes() }`.slice( -2 );
      const seconds = `0${ date.getSeconds() }`.slice( -2 );
      return `[${ hours }:${ minutes }:${ seconds }]`;
    }
    const line = [
      getTimePrefix(),
      'webpack',
      `(${ Math.round( progress * 100 ) }%)`,
      message ? `- ${message}` : '',
      moduleProgress ? `- ${moduleProgress}` : '',
      activeModules ? `- ${activeModules}` : '',
      moduleName ? `- ${moduleName}` : ''
    ].filter(Boolean).join(' ');
    console.log(line);
  };
  return new webpack.ProgressPlugin(handler);
}
