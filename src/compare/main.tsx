// SPDX-License-Identifier: MIT OR Apache-2.0
import React from 'react';
import {createRoot} from 'react-dom/client';
import CompareApp from './CompareApp';
import '../styles.css';
import '../jerry-theme.css';
import '../ui-polish.css';
import './compare.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><CompareApp/></React.StrictMode>);
