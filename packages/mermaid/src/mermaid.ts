/**
 * Web page integration module for the mermaid framework. It uses the mermaidAPI for mermaid
 * functionality and to render the diagrams to svg code!
 */
import dedent from 'ts-dedent';
import { MermaidConfig } from './config.type';
import { log } from './logger';
import utils from './utils';
import { mermaidAPI, ParseOptions, RenderResult } from './mermaidAPI';
import { registerLazyLoadedDiagrams, loadRegisteredDiagrams } from './diagram-api/detectType';
import type { ParseErrorFunction } from './Diagram';
import { isDetailedError } from './utils';
import type { DetailedError } from './utils';
import { ExternalDiagramDefinition } from './diagram-api/types';

export type {
  MermaidConfig,
  DetailedError,
  ExternalDiagramDefinition,
  ParseErrorFunction,
  RenderResult,
  ParseOptions,
};

/**
 * The options used when running mermaid.
 *
 * @param querySelector - The query selector to use when finding elements to render. Default: .mermaid
 * @param nodes - The nodes to render. If this is set, querySelector will be ignored.
 * @param postRenderCallback - A callback to call after each diagram is rendered.
 * @param suppressErrors - If true, errors will be logged to the console, but not thrown. Default: false
 */
export interface RunOptions {
  // Default: .mermaid
  querySelector?: string;
  nodes?: ArrayLike<HTMLElement>;
  postRenderCallback?: (id: string) => unknown;
  suppressErrors?: boolean;
}

const handleError = (error: unknown, errors: DetailedError[], parseError?: ParseErrorFunction) => {
  log.warn(error);
  if (isDetailedError(error)) {
    // handle case where error string and hash were
    // wrapped in object like`const error = { str, hash };`
    if (parseError) {
      parseError(error.str, error.hash);
    }
    errors.push({ ...error, message: error.str, error });
  } else {
    // assume it is just error string and pass it on
    if (parseError) {
      parseError(error);
    }
    if (error instanceof Error) {
      errors.push({
        str: error.message,
        message: error.message,
        hash: error.name,
        error,
      });
    }
  }
};

/**
 * ## run
 *
 * Function that goes through the document to find the chart definitions in there and render them.
 *
 * The function tags the processed attributes with the attribute data-processed and ignores found
 * elements with the attribute already set. This way the init function can be triggered several
 * times.
 *
 * ```mermaid
 * graph LR;
 *  a(Find elements)-->b{Processed}
 *  b-->|Yes|c(Leave element)
 *  b-->|No |d(Transform)
 * ```
 *
 * Renders the mermaid diagrams
 *
 * @param options - Optional runtime configs
 */
const run = async function (
  options: RunOptions = {
    querySelector: '.mermaid',
  }
) {
  try {
    await runThrowsErrors(options);
  } catch (e) {
    if (isDetailedError(e)) {
      log.error(e.str);
    }
    if (mermaid.parseError) {
      mermaid.parseError(e as string);
    }
    if (!options.suppressErrors) {
      log.error('Use the suppressErrors option to suppress these errors');
      throw e;
    }
  }
};

const runThrowsErrors = async function (
  { postRenderCallback, querySelector, nodes }: Omit<RunOptions, 'suppressErrors'> = {
    querySelector: '.mermaid',
  }
) {
  const conf = mermaidAPI.getConfig();

  log.debug(`${!postRenderCallback ? 'No ' : ''}Callback function found`);

  let nodesToProcess: ArrayLike<HTMLElement>;
  if (nodes) {
    nodesToProcess = nodes;
  } else if (querySelector) {
    nodesToProcess = document.querySelectorAll(querySelector);
  } else {
    throw new Error('Nodes and querySelector are both undefined');
  }

  log.debug(`Found ${nodesToProcess.length} diagrams`);
  if (conf?.startOnLoad !== undefined) {
    log.debug('Start On Load: ' + conf?.startOnLoad);
    mermaidAPI.updateSiteConfig({ startOnLoad: conf?.startOnLoad });
  }

  // generate the id of the diagram
  const idGenerator = new utils.initIdGenerator(conf.deterministicIds, conf.deterministicIDSeed);

  let txt: string;
  const errors: DetailedError[] = [];

  // element is the current div with mermaid class
  // eslint-disable-next-line unicorn/prefer-spread
  for (const element of Array.from(nodesToProcess)) {
    log.info('Rendering diagram: ' + element.id);
    /*! Check if previously processed */
    if (element.getAttribute('data-processed')) {
      continue;
    }
    element.setAttribute('data-processed', 'true');

    const id = `mermaid-${idGenerator.next()}`;

    // Fetch the graph definition including tags
    txt = element.innerHTML;

    // transforms the html to pure text
    txt = dedent(utils.entityDecode(txt)) // removes indentation, required for YAML parsing
      .trim()
      .replace(/<br\s*\/?>/gi, '<br/>');

    const init = utils.detectInit(txt);
    if (init) {
      log.debug('Detected early reinit: ', init);
    }
    try {
      const { svg, bindFunctions } = await mermaidAPI.render(id, txt, element);
      element.innerHTML = svg;
      if (postRenderCallback) {
        await postRenderCallback(id);
      }
      if (bindFunctions) {
        bindFunctions(element);
      }
    } catch (error) {
      handleError(error, errors, mermaid.parseError);
    }
  }
  if (errors.length > 0) {
    // TODO: We should be throwing an error object.
    throw errors[0];
  }
};

/**
 * Used to set configurations for mermaid.
 * This function should be called before the run function.
 * @param config - Configuration object for mermaid.
 */

const initialize = function (config: MermaidConfig) {
  mermaidAPI.initialize(config);
};

/**
 * ## init
 *
 * @deprecated Use {@link initialize} and {@link run} instead.
 *
 * Renders the mermaid diagrams
 *
 * @param config - **Deprecated**, please set configuration in {@link initialize}.
 * @param nodes - **Default**: `.mermaid`. One of the following:
 * - A DOM Node
 * - An array of DOM nodes (as would come from a jQuery selector)
 * - A W3C selector, a la `.mermaid`
 * @param callback - Called once for each rendered diagram's id.
 */
const init = async function (
  config?: MermaidConfig,
  nodes?: string | HTMLElement | NodeListOf<HTMLElement>,
  callback?: (id: string) => unknown
) {
  log.warn('mermaid.init is deprecated. Please use run instead.');
  if (config) {
    initialize(config);
  }
  const runOptions: RunOptions = { postRenderCallback: callback, querySelector: '.mermaid' };
  if (typeof nodes === 'string') {
    runOptions.querySelector = nodes;
  } else if (nodes) {
    if (nodes instanceof HTMLElement) {
      runOptions.nodes = [nodes];
    } else {
      runOptions.nodes = nodes;
    }
  }
  await run(runOptions);
};

/**
 * Used to register external diagram types.
 * @param diagrams - Array of {@link ExternalDiagramDefinition}.
 * @param opts - If opts.lazyLoad is false, the diagrams will be loaded immediately.
 */
const registerExternalDiagrams = async (
  diagrams: ExternalDiagramDefinition[],
  {
    lazyLoad = true,
  }: {
    lazyLoad?: boolean;
  } = {}
) => {
  registerLazyLoadedDiagrams(...diagrams);
  if (lazyLoad === false) {
    await loadRegisteredDiagrams();
  }
};

/**
 * ##contentLoaded Callback function that is called when page is loaded. This functions fetches
 * configuration for mermaid rendering and calls init for rendering the mermaid diagrams on the
 * page.
 */
const contentLoaded = function () {
  if (mermaid.startOnLoad) {
    const { startOnLoad } = mermaidAPI.getConfig();
    if (startOnLoad) {
      mermaid.run().catch((err) => log.error('Mermaid failed to initialize', err));
    }
  }
};

if (typeof document !== 'undefined') {
  /*!
   * Wait for document loaded before starting the execution
   */
  window.addEventListener('load', contentLoaded, false);
}

/**
 * ## setParseErrorHandler  Alternative to directly setting parseError using:
 *
 * ```js
 * mermaid.parseError = function(err,hash){=
 *   forExampleDisplayErrorInGui(err);  // do something with the error
 * };
 * ```
 *
 * This is provided for environments where the mermaid object can't directly have a new member added
 * to it (eg. dart interop wrapper). (Initially there is no parseError member of mermaid).
 *
 * @param parseErrorHandler - New parseError() callback.
 */
const setParseErrorHandler = function (parseErrorHandler: (err: any, hash: any) => void) {
  mermaid.parseError = parseErrorHandler;
};

const executionQueue: (() => Promise<unknown>)[] = [];
let executionQueueRunning = false;
const executeQueue = async () => {
  if (executionQueueRunning) {
    return;
  }
  executionQueueRunning = true;
  while (executionQueue.length > 0) {
    const f = executionQueue.shift();
    if (f) {
      try {
        await f();
      } catch (e) {
        log.error('Error executing queue', e);
      }
    }
  }
  executionQueueRunning = false;
};

/**
 * Parse the text and validate the syntax.
 * @param text - The mermaid diagram definition.
 * @param parseOptions - Options for parsing.
 * @returns true if the diagram is valid, false otherwise if parseOptions.suppressErrors is true.
 * @throws Error if the diagram is invalid and parseOptions.suppressErrors is false.
 */
const parse = async (text: string, parseOptions?: ParseOptions): Promise<boolean | void> => {
  return new Promise((resolve, reject) => {
    // This promise will resolve when the mermaidAPI.render call is done.
    // It will be queued first and will be executed when it is first in line
    const performCall = () =>
      new Promise((res, rej) => {
        mermaidAPI.parse(text, parseOptions).then(
          (r) => {
            // This resolves for the promise for the queue handling
            res(r);
            // This fulfills the promise sent to the value back to the original caller
            resolve(r);
          },
          (e) => {
            log.error('Error parsing', e);
            mermaid.parseError?.(e);
            rej(e);
            reject(e);
          }
        );
      });
    executionQueue.push(performCall);
    executeQueue().catch(reject);
  });
};

const render = (id: string, text: string, container?: Element): Promise<RenderResult> => {
  return new Promise((resolve, reject) => {
    // This promise will resolve when the mermaidAPI.render call is done.
    // It will be queued first and will be executed when it is first in line
    const performCall = () =>
      new Promise((res, rej) => {
        mermaidAPI.render(id, text, container).then(
          (r) => {
            // This resolves for the promise for the queue handling
            res(r);
            // This fulfills the promise sent to the value back to the original caller
            resolve(r);
          },
          (e) => {
            log.error('Error parsing', e);
            mermaid.parseError?.(e);
            rej(e);
            reject(e);
          }
        );
      });
    executionQueue.push(performCall);
    executeQueue().catch(reject);
  });
};

const mermaid: {
  startOnLoad: boolean;
  parseError?: ParseErrorFunction;
  mermaidAPI: typeof mermaidAPI;
  parse: typeof parse;
  render: typeof render;
  init: typeof init;
  run: typeof run;
  registerExternalDiagrams: typeof registerExternalDiagrams;
  initialize: typeof initialize;
  contentLoaded: typeof contentLoaded;
  setParseErrorHandler: typeof setParseErrorHandler;
} = {
  startOnLoad: true,
  mermaidAPI,
  parse,
  render,
  init,
  run,
  registerExternalDiagrams,
  initialize,
  parseError: undefined,
  contentLoaded,
  setParseErrorHandler,
};

export default mermaid;
