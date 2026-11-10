declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

declare global {
  interface Window {
    INITIAL_VIEW: 'sidebar' | 'graph';
  }
}

export {};
