import dynamic from 'next/dynamic';
import { Fragment, type PropsWithChildren } from 'react';

const NoSSRWrapperComponent = ({ children }: PropsWithChildren) => (
  <Fragment>{children}</Fragment>
);

const NoSSRWrapper = dynamic(() => Promise.resolve(NoSSRWrapperComponent), {
  ssr: false,
});

export default NoSSRWrapper;

