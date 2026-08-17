/**
 * Provider-backed Feed pages render in both editions. OSS calls are gated by
 * verified paid Cloud Link capabilities at the API boundary; keeping this
 * route group avoids breaking existing deep links.
 */

export default function HostedFeedPlatformLayout(props: {
  children: React.ReactNode;
}) {
  return props.children;
}
