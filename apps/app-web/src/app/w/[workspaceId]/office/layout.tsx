/** Keeps intercepted Office dialogs layered over the preserved routed surface. [COMP:app-web/office-navigation] */
export default function OfficeLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return <>{children}{modal}</>;
}
