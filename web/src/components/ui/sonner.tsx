import { Toaster as Sonner } from "sonner";

/** Global toast host — dark styling to match the app shell. */
export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "border-gray-700 bg-gray-900 text-gray-100",
          description: "text-gray-400",
        },
      }}
    />
  );
}
