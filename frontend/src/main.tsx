import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';

import App from './App';
import { queryClient } from '@/config/queryClient';
import { ThemeProvider } from '@/context/ThemeContext';
import { WebSocketProvider } from '@/context/WebSocketContext';
import AlertNotifications from '@/components/common/AlertNotifications';
import { installInputTrimOnBlur } from '@/utils/inputTrim';

// Styles — Tailwind design-system layer (tokens + Preflight; Bootstrap and its
// compat layer are fully removed — see docs/TAILWIND_MIGRATION_TRACKING.md).
import '@/styles/tailwind.css';
import 'react-toastify/dist/ReactToastify.css';
import '@/styles/global.scss';

// Trim leading/trailing whitespace from text inputs when they lose focus, so
// the user sees the cleaned value across every form in the app.
installInputTrimOnBlur();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <WebSocketProvider>
          <BrowserRouter>
            <App />
            <ToastContainer
            position="top-right"
            autoClose={3000}
            hideProgressBar={false}
            newestOnTop
            closeOnClick
            rtl={false}
            pauseOnFocusLoss
            draggable
            pauseOnHover
            theme="light"
          />
            {/* Real-time alert notifications (bottom-right corner) */}
            <AlertNotifications
              enabled={true}
              maxNotifications={5}
              autoDismissMs={10000}
              playSound={true}
            />
          </BrowserRouter>
        </WebSocketProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
