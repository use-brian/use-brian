"use client";

import { useState } from 'react';

/** Local, non-persistent accessible feedback. Never pass credentials to toast. */
export function useToast() {
  const [message, setMessage] = useState('');
  return { toast: setMessage, feedback: message ? <p role="status" className="text-sm">{message}</p> : null };
}
