// Main Application Module
const WhatsAppBulkSender = (() => {
  // State
  const state = {
    isSending: false,
    stopSending: false,
    results: [],
    currentFile: null,
    worksheetData: [],
    headers: [],
    currentPage: 1,
    itemsPerPage: 10,
    dailyLimit: 100,
    sessionLimit: 100,
    messagesSentToday: 0,
    messagesSentThisSession: 0
  };

  // DOM Elements
  const elements = {
    // File Upload
    fileInput: document.getElementById('fileInput'),
    dropArea: document.getElementById('drop-area'),
    browseBtn: document.getElementById('browseBtn'),
    clearFileBtn: document.getElementById('clear-file'),
    fileDetails: document.getElementById('file-details'),
    fileName: document.getElementById('file-name'),
    fileSize: document.getElementById('file-size'),
    fileStatus: document.getElementById('file-status'),
    
    // Message
    messageInput: document.getElementById('message'),
    
    // Sending Controls
    startSendingBtn: document.getElementById('start-sending'),
    stopSendingBtn: document.getElementById('stop-sending'),
    
    // Progress
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    
    // Results
    resultsSection: document.getElementById('results-section'),
    resultsBody: document.getElementById('results-body'),
    successCount: document.getElementById('success-count'),
    failedCount: document.getElementById('failed-count'),
    totalCount: document.getElementById('total-count'),
    
    // Activity Log
    activityLog: document.getElementById('activity-log'),
    
    // Toast
    toast: document.getElementById('toast'),
    toastIcon: document.getElementById('toast-icon'),
    toastMessage: document.getElementById('toast-message'),
    
    // Phone Number Validation
    phoneColumnSelect: document.getElementById('phone-column'),
    countryCodeSelect: document.getElementById('countryCode'),

    // Limits and Delays
    dailyLimitInput: document.getElementById('daily-limit'),
    sessionLimitInput: document.getElementById('session-limit'),
    baseDelayInput: document.getElementById('base-delay'),
    jitterInput: document.getElementById('jitter')
  };

  // Initialize the application
  const init = () => {
    // Update DOM elements
    updateDOMElements();

    // Load persistent country code
    const savedCountryCode = localStorage.getItem('selectedCountryCode');
    if (savedCountryCode && elements.countryCodeSelect) {
      elements.countryCodeSelect.value = savedCountryCode;
    }

    // Set up event listeners
    setupEventListeners();

    // Update country code status
    updateCountryCodeStatus();

    // Check connection status
    checkConnection();

    // Check connection every 30 seconds
    setInterval(checkConnection, 30000);

    // Initialize tooltips
    if (typeof tippy === 'function') {
      tippy('[data-tippy-content]');
    }

    // Disable send button initially
    if (elements.startSendingBtn) {
      elements.startSendingBtn.disabled = true;
    }

    // Initialize validNumbers as empty array
    state.validNumbers = [];
  };

  // Set up event listeners
  const setupEventListeners = () => {
    // File upload
    if (elements.browseBtn) {
      elements.browseBtn.addEventListener('click', () => elements.fileInput.click());
    }
    
    if (elements.fileInput) {
      elements.fileInput.addEventListener('change', handleFileUpload);
    }
    
    if (elements.clearFileBtn) {
      elements.clearFileBtn.addEventListener('click', clearFile);
    }
    
    // Start/Stop sending
    if (elements.startSendingBtn) {
      elements.startSendingBtn.addEventListener('click', startSending);
    }
    
    if (elements.stopSendingBtn) {
      elements.stopSendingBtn.addEventListener('click', stopSending);
    }
    
    // Country code change
    if (elements.countryCodeSelect) {
      elements.countryCodeSelect.addEventListener('change', () => {
        // Save to localStorage
        const selectedCountry = elements.countryCodeSelect.value;
        if (selectedCountry) {
          localStorage.setItem('selectedCountryCode', selectedCountry);
        }

        // Update country code status
        updateCountryCodeStatus();

        // Update preview if data exists
        if (state.worksheetData && state.worksheetData.length > 0) {
          updatePreview();

          // Show preview section
          document.getElementById('preview-section').classList.remove('hidden');
        }
      });
    }

    // Daily limit change
    if (elements.dailyLimitInput) {
      // Load saved daily limit
      const savedDailyLimit = localStorage.getItem('dailyLimit');
      if (savedDailyLimit) {
        elements.dailyLimitInput.value = savedDailyLimit;
        state.dailyLimit = parseInt(savedDailyLimit);
      }

      elements.dailyLimitInput.addEventListener('change', () => {
        const limit = parseInt(elements.dailyLimitInput.value) || 100;
        state.dailyLimit = limit;
        localStorage.setItem('dailyLimit', limit);
      });
    }
    
    // Drag and drop
    if (elements.dropArea) {
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        elements.dropArea.addEventListener(eventName, preventDefaults, false);
      });
      
      ['dragenter', 'dragover'].forEach(eventName => {
        elements.dropArea.addEventListener(eventName, highlight, false);
      });
      
      ['dragleave', 'drop'].forEach(eventName => {
        elements.dropArea.addEventListener(eventName, unhighlight, false);
      });
      
      elements.dropArea.addEventListener('drop', handleDrop, false);
    }
  };

  // Clear file selection
  const clearFile = () => {
    elements.fileInput.value = '';
    elements.fileDetails.classList.add('hidden');
    state.worksheetData = [];
    state.headers = [];
    state.validNumbers = [];
    elements.startSendingBtn.disabled = true;
    document.getElementById('preview-section').classList.add('hidden');
    document.getElementById('variable-mapping-section').classList.add('hidden');

    // Send button is already disabled above
  };

  // Handle file upload
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Check if country code is selected
    const countryCode = elements.countryCodeSelect?.value;
    if (!countryCode || countryCode === '') {
      showToast('Please select a country code before uploading the file', 'warning');
      return;
    }

    // Validate file type
    const validTypes = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(xlsx|xls|csv)$/i)) {
      showToast('Please upload a valid Excel or CSV file', 'error');
      return;
    }

    // Update file info UI
    elements.fileName.textContent = file.name;
    elements.fileSize.textContent = formatFileSize(file.size);
    elements.fileDetails.classList.remove('hidden');
    elements.fileStatus.textContent = 'Processing file...';
    elements.fileStatus.className = 'mt-2 text-xs text-blue-600';

    // Process the file
    processFile(file);
  };

  // Phone number validation rules by country code
  const phoneValidationRules = {
    '1': { minLength: 10, maxLength: 10, name: 'US/Canada' }, // US/Canada
    '91': { minLength: 10, maxLength: 10, name: 'India' }, // India
    '44': { minLength: 10, maxLength: 10, name: 'UK' }, // UK
    '971': { minLength: 9, maxLength: 9, name: 'UAE' }, // UAE
    '966': { minLength: 9, maxLength: 9, name: 'Saudi Arabia' }, // Saudi Arabia
    '92': { minLength: 10, maxLength: 10, name: 'Pakistan' }, // Pakistan
    '880': { minLength: 10, maxLength: 10, name: 'Bangladesh' }, // Bangladesh
    '65': { minLength: 8, maxLength: 8, name: 'Singapore' }, // Singapore
    '60': { minLength: 9, maxLength: 10, name: 'Malaysia' } // Malaysia
  };

  // Get default validation rules
  const getDefaultValidationRules = (countryCode) => ({
    minLength: 8,
    maxLength: 15,
    name: 'International'
  });

  // Simple phone formatting - just add country code
  const formatPhone = (phone, countryCode = '91') => {
    if (!phone) return '';

    // Convert to string and remove all non-digits
    const digitsOnly = String(phone).replace(/\D/g, '');
    return countryCode + digitsOnly;
  };
  
  // Update preview with validation results
  const updatePreview = (forceValidation = false) => {
    const previewBody = document.getElementById('preview-body');
    if (!previewBody) return;

    previewBody.innerHTML = '';
    let validCount = 0;
    let invalidCount = 0;

    // Get phone column index
    const phoneColumnIndex = parseInt(document.getElementById('phone-column')?.value || '0', 10);
    const countryCode = document.getElementById('countryCode')?.value || '91';

    // Debug: Log raw phone numbers from the selected column
    console.log('=== Phone Number Detection Debug ===');
    console.log('Selected phone column index:', phoneColumnIndex);
    console.log('Country code:', countryCode);
    console.log('Raw phone numbers from file:');
    state.worksheetData.slice(0, 10).forEach((row, index) => {
      console.log(`Row ${index + 1}: "${row[phoneColumnIndex]}" (type: ${typeof row[phoneColumnIndex]})`);
    });

    // Show preview section
    document.getElementById('preview-section').classList.remove('hidden');

    // Update country code display
    const countryCodeDisplay = document.getElementById('selected-country-code');
    if (countryCodeDisplay) {
      countryCodeDisplay.textContent = `+${countryCode}`;
    }

    // Update table headers dynamically to show Excel headers as they are
    const theadRow = document.querySelector('#preview-section thead tr');
    if (theadRow) {
      theadRow.innerHTML = `
        <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
      `;

      // Add all Excel headers
      state.headers.forEach((header, index) => {
        const th = document.createElement('th');
        th.scope = 'col';
        let className = 'px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
        if (index === phoneColumnIndex) {
          className += ' bg-blue-100 border-blue-300';
        }
        th.className = className;
        th.textContent = header;
        theadRow.appendChild(th);
      });
    }

    // Create table row for each data row
    state.worksheetData.slice(0, 100).forEach((row, index) => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-gray-200 hover:bg-gray-50';

      // Row number
      const rowNumCell = document.createElement('td');
      rowNumCell.className = 'px-6 py-4 whitespace-nowrap text-sm text-gray-900';
      rowNumCell.textContent = index + 1;
      tr.appendChild(rowNumCell);

      // All columns from Excel data
      state.headers.forEach((header, headerIndex) => {
        const cell = document.createElement('td');
        let className = 'px-6 py-4 text-sm text-gray-500';
        if (headerIndex === phoneColumnIndex) {
          className += ' bg-green-50 border-green-200';
        }
        cell.className = className;
        cell.textContent = row[headerIndex] || '';
        tr.appendChild(cell);
      });

      previewBody.appendChild(tr);
    });

    // Update counts
    const showingCountEl = document.getElementById('showing-count');
    const totalCountEl = document.getElementById('total-count');
    const validCountEl = document.getElementById('valid-count');
    const invalidCountEl = document.getElementById('invalid-count');

    if (showingCountEl) showingCountEl.textContent = Math.min(100, state.worksheetData.length);
    if (totalCountEl) totalCountEl.textContent = state.worksheetData.length;
    if (validCountEl) validCountEl.textContent = validCount;
    if (invalidCountEl) invalidCountEl.textContent = invalidCount;

    // Send button is enabled when file is uploaded
  };

  // Process uploaded file
  const processFile = (file) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // Convert to JSON
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (jsonData.length < 2) {
          throw new Error('The file is empty or has no data');
        }

        // Store headers and data
        state.headers = jsonData[0];
        state.worksheetData = jsonData.slice(1);
        state.currentFile = file;

        // Check daily limit
        const rowCount = state.worksheetData.length;
        const dailyLimit = state.dailyLimit;
        if (rowCount > dailyLimit) {
          showToast(`File has ${rowCount} rows which exceeds daily limit of ${dailyLimit}. Please reduce the file size.`, 'error');
          elements.fileStatus.textContent = `Error: ${rowCount} rows exceeds daily limit of ${dailyLimit}`;
          elements.fileStatus.className = 'mt-2 text-xs text-red-600';
          clearFile();
          return;
        }

        // Clean headers (remove special characters and trim)
        state.headers = state.headers.map(header =>
          String(header || '').trim().replace(/[^\w\s]/g, '').replace(/\s+/g, '_')
        );

        // Show variable mapping section
        showVariableMapping();

        // Auto-detect phone column if possible
        autoDetectPhoneColumn();

        // Update preview after column detection
        updatePreview();

        // Update file status
        elements.fileStatus.textContent = `Found ${state.worksheetData.length} records`;
        elements.fileStatus.className = 'mt-2 text-xs text-green-600';

        showToast('File processed successfully', 'success');
        addActivityLog(`File "${file.name}" loaded with ${state.worksheetData.length} records`);

        // Enable send button and show progress section since we have data
        if (elements.startSendingBtn) {
          elements.startSendingBtn.disabled = false;
        }
        document.getElementById('progress-section').classList.remove('hidden');

      } catch (error) {
        console.error('Error processing file:', error);
        showToast(`Error: ${error.message}`, 'error');
        elements.fileStatus.textContent = `Error: ${error.message}`;
        elements.fileStatus.className = 'mt-2 text-xs text-red-600';
      }
    };

    reader.onerror = (error) => {
      console.error('Error reading file:', error);
      showToast('Error reading file. Please try again.', 'error');
      elements.fileStatus.textContent = 'Error reading file';
      elements.fileStatus.className = 'mt-2 text-xs text-red-600';
    };

    // Read the file as array buffer
    reader.readAsArrayBuffer(file);
  };

  // Calculate random delay with base and jitter
  const getRandomDelay = () => {
    const baseDelay = elements.baseDelayInput ? parseInt(elements.baseDelayInput.value) || 30 : 30;
    const jitter = elements.jitterInput ? parseInt(elements.jitterInput.value) || 5 : 5;

    // Ensure base delay is within 20-60 range
    const clampedBaseDelay = Math.max(20, Math.min(60, baseDelay));
    // Ensure jitter is within 5-10 range
    const clampedJitter = Math.max(5, Math.min(10, jitter));

    // Calculate random jitter: -jitter to +jitter
    const randomJitter = (Math.random() * 2 - 1) * clampedJitter;
    const finalDelay = clampedBaseDelay + randomJitter;

    // Ensure final delay is at least 1 second
    return Math.max(1, Math.round(finalDelay * 1000));
  };

  // Start sending messages
  const startSending = async () => {
    if (state.isSending) return;

    // Check if we have data
    if (!state.worksheetData || state.worksheetData.length < 1) {
      showToast('No data found. Please upload a file first.', 'error');
      return;
    }

    // Check session limit (max 100 messages per session)
    const totalRows = state.worksheetData.length;
    if (totalRows > state.sessionLimit) {
      showToast(`Session limit exceeded. Maximum ${state.sessionLimit} messages per session. Your file has ${totalRows} rows.`, 'error');
      return;
    }

    state.isSending = true;
    state.stopSending = false;
    state.results = [];
    state.messagesSentThisSession = 0;

    // Get end at row (1-based index, optional)
    const endAtInput = document.getElementById('end-at');
    const endAt = endAtInput && endAtInput.value ? parseInt(endAtInput.value) : null;

    elements.startSendingBtn.disabled = true;
    elements.stopSendingBtn.classList.remove('hidden');
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = '0%';
    elements.successCount.textContent = '0';
    elements.failedCount.textContent = '0';

    // Get start from row (1-based index)
    const startFromInput = document.getElementById('start-from');
    const startFrom = startFromInput ? Math.max(1, parseInt(startFromInput.value) || 1) : 1;

    const totalToSend = endAt ? Math.min(endAt, state.worksheetData.length) - startFrom + 1 : state.worksheetData.length - startFrom + 1;
    elements.totalCount.textContent = totalToSend;

    // Show progress section
    document.getElementById('progress-section').classList.remove('hidden');
    document.getElementById('results-section').classList.remove('hidden');
    elements.resultsBody.innerHTML = '';

    // Get message template
    const messageTemplate = elements.messageInput.value.trim();
    if (!messageTemplate) {
      showToast('Please enter a message template', 'error');
      stopSending();
      return;
    }

    // Validate end at row
    if (endAt && endAt < startFrom) {
      showToast('End row must be greater than or equal to start row', 'error');
      stopSending();
      return;
    }

    // Get phone column index
    const phoneColumnSelect = document.getElementById('phone-column');
    if (!phoneColumnSelect || !phoneColumnSelect.value) {
      showToast('Please select a valid phone number column', 'error');
      stopSending();
      return;
    }
    const phoneColumnIndex = parseInt(phoneColumnSelect.value);
    if (isNaN(phoneColumnIndex) || phoneColumnIndex < 0) {
      showToast('Please select a valid phone number column', 'error');
      stopSending();
      return;
    }

    // Get country code
    const countryCode = document.getElementById('countryCode')?.value || '91';

    // Process messages sequentially (one at a time) to apply delays between each message
    const batchSize = 1; // Send one message at a time
    let successCount = 0;
    let failCount = 0;

    // Determine the actual end row
    const actualEndRow = endAt ? Math.min(endAt, totalRows) : totalRows;

    // Process rows in batches
    for (let i = startFrom - 1; i < actualEndRow; i += batchSize) {
      if (state.stopSending) {
        addActivityLog('Sending stopped by user', 'warning');
        break;
      }

      // Get current batch from worksheet data
      const batch = state.worksheetData.slice(i, i + batchSize);

      // Process each row sequentially
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
        if (state.stopSending) {
          addActivityLog('Sending stopped by user', 'warning');
          break;
        }

        const row = batch[batchIndex];
        const originalIndex = i + batchIndex;

        const result = await processRow(row, originalIndex, phoneColumnIndex, messageTemplate, countryCode);

        if (result.success) {
          successCount++;
          state.messagesSentThisSession++;
          elements.successCount.textContent = successCount;
        } else {
          failCount++;
          elements.failedCount.textContent = failCount;
        }

        // Update progress
        const progress = Math.round(((originalIndex + 1) / totalRows) * 100);
        elements.progressBar.style.width = `${progress}%`;
        elements.progressText.textContent = `${progress}%`;

        // Add to results
        addResultToTable(result, originalIndex + 1);

        // Check session limit after each message
        if (state.messagesSentThisSession >= state.sessionLimit) {
          addActivityLog(`Session limit of ${state.sessionLimit} messages reached`, 'warning');
          showToast(`Session limit of ${state.sessionLimit} messages reached`, 'warning');
          break;
        }

        // Add random delay between messages (not after the last one)
        if (originalIndex < actualEndRow - 1 && !state.stopSending) {
          const randomDelay = getRandomDelay();
          addActivityLog(`Waiting ${Math.round(randomDelay / 1000)}s before next message...`);
          await new Promise(resolve => setTimeout(resolve, randomDelay));
        }
      }
    }

    // Update UI when done
    if (!state.stopSending) {
      showToast(`Completed sending ${successCount} messages successfully (${failCount} failed)`, 'success');
      addActivityLog(`Bulk send completed: ${successCount} sent, ${failCount} failed`);
    }
    
    stopSending();
  };
  
  // Process a single row and send message
  const processRow = async (row, index, phoneColumnIndex, messageTemplate, countryCode) => {
    try {
      // Get phone number and format it
      const rawPhoneNumber = row[phoneColumnIndex];
      if (!rawPhoneNumber) {
        return { success: false, error: 'No phone number', row: index + 1 };
      }

      // Format phone number with country code
      const phoneNumber = formatPhone(rawPhoneNumber, countryCode);

      // Prepare message with variables
      let message = messageTemplate;
      state.headers.forEach((header, idx) => {
        if (header && row[idx] !== undefined && row[idx] !== null) {
          const headerStr = String(header).toLowerCase().trim();
          if (headerStr) {
            const placeholder = `{${headerStr}}`;
            message = message.replace(new RegExp(placeholder, 'g'), String(row[idx]));
          }
        }
      });

      // Send message via API
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: phoneNumber, message })
      });

      const data = await response.json();

      // Check both HTTP status and API response success field
      if (response.ok && data.success) {
        return {
          success: true,
          phone: phoneNumber,
          message: data.message || 'Message sent successfully',
          row: index + 1
        };
      } else {
        throw new Error(data.error || data.message || 'Failed to send message');
      }

    } catch (error) {
      console.error(`Error sending message to row ${index + 1}:`, error);
      return {
        success: false,
        error: error.message,
        phone: formatPhone(row[phoneColumnIndex], countryCode) || 'N/A',
        row: index + 1
      };
    }
  };
  
  // Add result to results table
  const addResultToTable = (result, index) => {
    const row = document.createElement('tr');
    
    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = `px-2 py-1 text-xs font-semibold rounded-full ${result.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`;
    statusBadge.textContent = result.success ? 'Success' : 'Failed';
    
    // Time
    const time = new Date().toLocaleTimeString();
    
    // Build row
    row.innerHTML = `
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${index}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${result.phone || 'N/A'}</td>
      <td class="px-6 py-4 whitespace-nowrap">${statusBadge.outerHTML}</td>
      <td class="px-6 py-4 text-sm text-gray-500">${result.error || result.message || 'N/A'}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${time}</td>
    `;
    
    // Add to table (at the top)
    elements.resultsBody.insertBefore(row, elements.resultsBody.firstChild);
  };

  // Stop sending messages
  const stopSending = () => {
    state.stopSending = true;
    state.isSending = false;
    
    elements.startSendingBtn.disabled = false;
    elements.stopSendingBtn.classList.add('hidden');
    
    showToast('Sending stopped', 'warning');
    addActivityLog('Sending was stopped by user', 'warning');
  };

  // Show toast notification
  const showToast = (message, type = 'info') => {
    const toast = elements.toast;
    const icon = elements.toastIcon;
    const messageEl = elements.toastMessage;
    
    // Set icon and color based on type
    let iconClass = '';
    let bgColor = '';
    
    switch (type) {
      case 'success':
        iconClass = 'fas fa-check-circle';
        bgColor = 'bg-green-500';
        break;
      case 'error':
        iconClass = 'fas fa-exclamation-circle';
        bgColor = 'bg-red-500';
        break;
      case 'warning':
        iconClass = 'fas fa-exclamation-triangle';
        bgColor = 'bg-yellow-500';
        break;
      default:
        iconClass = 'fas fa-info-circle';
        bgColor = 'bg-blue-500';
    }
    
    // Update toast content
    icon.className = `${iconClass} text-white mr-2`;
    messageEl.textContent = message;
    toast.className = `fixed bottom-4 right-4 ${bgColor} text-white px-4 py-2 rounded-md shadow-lg flex items-center`;
    
    // Show toast
    toast.classList.remove('hidden');
    
    // Hide toast after delay
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 5000);
  };

  // Add log to activity
  const addActivityLog = (message, type = 'info') => {
    const logEntry = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();
    
    let iconClass = '';
    let textColor = '';
    
    switch (type) {
      case 'success':
        iconClass = 'fas fa-check-circle text-green-500';
        textColor = 'text-green-700';
        break;
      case 'error':
        iconClass = 'fas fa-times-circle text-red-500';
        textColor = 'text-red-700';
        break;
      case 'warning':
        iconClass = 'fas fa-exclamation-triangle text-yellow-500';
        textColor = 'text-yellow-700';
        break;
      default:
        iconClass = 'fas fa-info-circle text-blue-500';
        textColor = 'text-blue-700';
    }
    
    logEntry.className = `flex items-start mb-2 ${textColor}`;
    logEntry.innerHTML = `
      <i class="${iconClass} mt-1 mr-2"></i>
      <span class="text-sm">[${timestamp}] ${message}</span>
    `;
    
    elements.activityLog.insertBefore(logEntry, elements.activityLog.firstChild);
    
    // Limit number of log entries
    if (elements.activityLog.children.length > 100) {
      elements.activityLog.removeChild(elements.activityLog.lastChild);
    }
  };

  // Check server connection
  const checkConnection = async () => {
    try {
      const response = await fetch('/api/status');
      const data = await response.json();
      
      const statusElement = document.getElementById('connectionStatus');
      if (statusElement) {
        const statusDot = statusElement.querySelector('.status-dot');
        const statusText = statusElement.querySelector('.status-text');
        
        if (data.connected) {
          statusDot.className = 'status-dot h-2 w-2 rounded-full bg-green-500 mr-2';
          statusText.textContent = 'Connected';
        } else {
          statusDot.className = 'status-dot h-2 w-2 rounded-full bg-red-500 mr-2';
          statusText.textContent = 'Disconnected';
        }
      }
    } catch (error) {
      console.error('Connection check failed:', error);
      const statusElement = document.getElementById('connectionStatus');
      if (statusElement) {
        const statusDot = statusElement.querySelector('.status-dot');
        const statusText = statusElement.querySelector('.status-text');
        statusDot.className = 'status-dot h-2 w-2 rounded-full bg-yellow-500 mr-2';
        statusText.textContent = 'Connection Error';
      }
    }
  };

  // Drag and drop functions
  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function highlight() {
    elements.dropArea.classList.add('border-blue-400', 'bg-blue-50');
  }

  function unhighlight() {
    elements.dropArea.classList.remove('border-blue-400', 'bg-blue-50');
  }

  function handleDrop(e) {
    const dt = e.dataTransfer;
    const file = dt.files[0];
    if (file) {
      // Update the file input to reflect the dropped file
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      elements.fileInput.files = dataTransfer.files;
      
      // Trigger the file upload handler
      const event = new Event('change');
      elements.fileInput.dispatchEvent(event);
    }
  };

  // Auto-detect phone number column
  const autoDetectPhoneColumn = () => {
    console.log('=== Auto-Detect Phone Column Debug ===');
    console.log('Headers:', state.headers);
    console.log('Total columns:', state.headers.length);
    console.log('Total rows:', state.worksheetData.length);
    console.log('First 5 rows of data:', state.worksheetData.slice(0, 5));

    const phoneColumnSelect = document.getElementById('phone-column');
    if (!phoneColumnSelect || !state.headers || state.headers.length === 0) return;

    // Clear existing options
    phoneColumnSelect.innerHTML = '';

    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select phone number column';
    phoneColumnSelect.appendChild(defaultOption);

    // Add column options
    state.headers.forEach((header, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = `${header} (Column ${String.fromCharCode(65 + index)})`;
      phoneColumnSelect.appendChild(option);
    });

    // Common phone column names for detection
    const phoneKeywords = ['phone', 'number', 'mobile', 'contact', 'whatsapp', 'phonenumber', 'phone_number', 'contactno'];

    let detectedColumnIndex = -1;

    // First try header-based detection
    detectedColumnIndex = state.headers.findIndex(header =>
      header && phoneKeywords.some(keyword =>
        String(header).toLowerCase().includes(keyword.toLowerCase())
      )
    );

    console.log('Header-based detection result:', detectedColumnIndex);

    // If header detection failed, try data-based detection
    if (detectedColumnIndex === -1 && state.worksheetData.length > 0) {
      console.log('Header detection failed, trying data pattern matching...');

      const columnScores = [];

      for (let colIndex = 0; colIndex < state.headers.length; colIndex++) {
        const sampleData = state.worksheetData.slice(0, Math.min(20, state.worksheetData.length))
          .map(row => row[colIndex])
          .filter(val => val !== null && val !== undefined && val !== '');

        console.log(`Column ${colIndex} (${state.headers[colIndex] || 'unnamed'}) samples:`, sampleData.slice(0, 10));

        if (sampleData.length === 0) {
          columnScores.push({ index: colIndex, score: 0 });
          continue;
        }

        let phoneScore = 0;
        let textScore = 0;

        sampleData.forEach(val => {
          const str = String(val);
          const digitsOnly = str.replace(/\D/g, '');

          console.log(`  Analyzing "${str}" (type: ${typeof val}) -> digits: "${digitsOnly}" (${digitsOnly.length} digits)`);

          // Phone-like patterns - check for actual phone number lengths
          if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
            phoneScore += 3; // Strong phone indicator
            console.log(`    -> Strong phone match (+3)`);
          } else if (digitsOnly.length >= 7 && digitsOnly.length <= 9) {
            phoneScore += 2; // Medium phone indicator
            console.log(`    -> Medium phone match (+2)`);
          } else if (digitsOnly.length >= 3 && digitsOnly.length <= 6) {
            phoneScore += 1; // Weak phone indicator
            console.log(`    -> Weak phone match (+1)`);
          } else {
            console.log(`    -> Not phone-like`);
          }

          // Text patterns (names typically have letters and are not pure numbers)
          if (/[a-zA-Z]/.test(str) && str.length > 2 && str.length < 50 && digitsOnly.length < str.length * 0.5) {
            textScore += 2;
            console.log(`    -> Text content (+2 text score)`);
          } else if (/[a-zA-Z]/.test(str)) {
            textScore += 1;
            console.log(`    -> Mixed content (+1 text score)`);
          }
        });

        // Calculate final score (phone score minus text score to prefer phone columns)
        const finalScore = phoneScore - textScore;
        columnScores.push({ index: colIndex, score: finalScore, phoneScore, textScore });
        console.log(`Column ${colIndex} final score: ${finalScore} (phone: ${phoneScore}, text: ${textScore})`);
      }

      // Sort by score descending and pick the highest
      columnScores.sort((a, b) => b.score - a.score);
      console.log('Column scores sorted:', columnScores);

      if (columnScores[0].score > 0) {
        detectedColumnIndex = columnScores[0].index;
        console.log('Selected column by data pattern:', detectedColumnIndex);
      }
    }

    // For 2-column files, if still not detected, prefer the column with more numeric data
    if (detectedColumnIndex === -1 && state.headers.length === 2) {
      console.log('=== 2-Column Detection Debug ===');

      const col0Samples = state.worksheetData.slice(0, Math.min(10, state.worksheetData.length))
        .map(row => row[0]).filter(val => val !== null && val !== undefined && val !== '');
      const col1Samples = state.worksheetData.slice(0, Math.min(10, state.worksheetData.length))
        .map(row => row[1]).filter(val => val !== null && val !== undefined && val !== '');

      console.log('Column 0 samples:', col0Samples.slice(0, 5));
      console.log('Column 1 samples:', col1Samples.slice(0, 5));

      let col0PhoneScore = 0;
      let col1PhoneScore = 0;

      col0Samples.forEach(val => {
        const str = String(val);
        const digitsOnly = str.replace(/\D/g, '');
        console.log(`Col 0: "${str}" -> "${digitsOnly}" (${digitsOnly.length} digits)`);
        if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
          col0PhoneScore += 3;
          console.log(`  -> Strong phone (+3)`);
        } else if (digitsOnly.length >= 7 && digitsOnly.length <= 9) {
          col0PhoneScore += 2;
          console.log(`  -> Medium phone (+2)`);
        } else if (digitsOnly.length >= 3 && digitsOnly.length <= 6) {
          col0PhoneScore += 1;
          console.log(`  -> Weak phone (+1)`);
        }
        // Penalize text-heavy entries
        if (/[a-zA-Z]/.test(str) && digitsOnly.length < str.length * 0.5) {
          col0PhoneScore -= 2;
          console.log(`  -> Text heavy (-2)`);
        } else if (/[a-zA-Z]/.test(str)) {
          col0PhoneScore -= 1;
          console.log(`  -> Mixed content (-1)`);
        }
      });

      col1Samples.forEach(val => {
        const str = String(val);
        const digitsOnly = str.replace(/\D/g, '');
        console.log(`Col 1: "${str}" -> "${digitsOnly}" (${digitsOnly.length} digits)`);
        if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
          col1PhoneScore += 3;
          console.log(`  -> Strong phone (+3)`);
        } else if (digitsOnly.length >= 7 && digitsOnly.length <= 9) {
          col1PhoneScore += 2;
          console.log(`  -> Medium phone (+2)`);
        } else if (digitsOnly.length >= 3 && digitsOnly.length <= 6) {
          col1PhoneScore += 1;
          console.log(`  -> Weak phone (+1)`);
        }
        // Penalize text-heavy entries
        if (/[a-zA-Z]/.test(str) && digitsOnly.length < str.length * 0.5) {
          col1PhoneScore -= 2;
          console.log(`  -> Text heavy (-2)`);
        } else if (/[a-zA-Z]/.test(str)) {
          col1PhoneScore -= 1;
          console.log(`  -> Mixed content (-1)`);
        }
      });

      console.log('Column 0 phone score:', col0PhoneScore);
      console.log('Column 1 phone score:', col1PhoneScore);

      detectedColumnIndex = col1PhoneScore > col0PhoneScore ? 1 : 0;
      console.log('Selected column:', detectedColumnIndex);
    }

    // Default to first column if no detection worked
    if (detectedColumnIndex === -1) {
      detectedColumnIndex = 0;
    }

    phoneColumnSelect.value = detectedColumnIndex;

    // Also update the variable name to 'phone' for consistency
    const varInput = document.querySelector(`#variable-mapping-container input[data-column-index="${detectedColumnIndex}"]`);
    if (varInput) {
      varInput.value = 'phone';
      // Trigger change to update preview
      varInput.dispatchEvent(new Event('change'));
    }

    // Trigger change event to update preview
    phoneColumnSelect.dispatchEvent(new Event('change'));
    
    // Update preview when column selection changes
    phoneColumnSelect.addEventListener('change', updatePreview);
  };

  // Show variable mapping section
  const showVariableMapping = () => {
    const container = document.getElementById('variable-mapping-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    state.headers.forEach((header, index) => {
      if (!header) return;
      
      const row = document.createElement('div');
      row.className = 'grid grid-cols-3 gap-4 py-2 border-b';
      
      // Column name
      const colName = document.createElement('div');
      colName.className = 'flex items-center';
      colName.textContent = header;
      
      // Variable input
      const varInput = document.createElement('input');
      varInput.type = 'text';
      varInput.className = 'w-full px-2 py-1 border rounded variable-name';
      varInput.dataset.columnIndex = index;
      
      // Create a valid variable name (alphanumeric + underscore, no spaces)
      const cleanHeader = header
        .toString()
        .toLowerCase()
        .replace(/[^\w\s]/g, '')  // Remove special chars
        .trim()
        .replace(/\s+/g, '_')      // Replace spaces with underscore
        .replace(/^\d+/, '')        // Remove leading numbers
        .replace(/[^\w]/g, '');     // Remove any remaining non-word chars
        
      // Ensure the variable name is not empty
      varInput.value = cleanHeader || `col_${index + 1}`;
      
      // Add change event to update preview
      varInput.addEventListener('input', (e) => {
        // Clean the input value
        const cleanValue = e.target.value
          .toLowerCase()
          .replace(/[^\w]/g, '');
          
        e.target.value = cleanValue;
        
        // Update the preview
        const preview = e.target.parentElement.nextElementSibling;
        if (preview) {
          preview.textContent = `{${cleanValue}}`;
        }
      });
      
      // Preview
      const preview = document.createElement('div');
      preview.className = 'flex items-center text-sm text-gray-600';
      preview.textContent = `{${varInput.value}}`;
      
      // Append elements
      row.appendChild(colName);
      row.appendChild(varInput);
      row.appendChild(preview);
      container.appendChild(row);
    });
    
    // Show the section
    const varMappingSection = document.getElementById('variable-mapping-section');
    if (varMappingSection) {
      varMappingSection.classList.remove('hidden');
    }
  };
  
  // Format file size
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  // Update the DOM elements in the state
  const updateDOMElements = () => {
    // Update any dynamic elements that might have been added after initial load
    elements.fileDetails = document.getElementById('file-details');
    elements.fileName = document.getElementById('file-name');
    elements.fileSize = document.getElementById('file-size');
    elements.fileStatus = document.getElementById('file-status');
  };

  // Update country code status display
  const updateCountryCodeStatus = () => {
    const countryCode = elements.countryCodeSelect?.value;
    const statusElement = document.getElementById('country-code-status');

    if (statusElement) {
      if (countryCode && countryCode !== '') {
        statusElement.innerHTML = `
          <div class="flex items-center text-green-600">
            <i class="fas fa-check-circle mr-2"></i>
            Country code selected: +${countryCode}
          </div>
        `;
        statusElement.className = 'mt-2 text-sm';

        // Enable file upload
        if (elements.fileInput) {
          elements.fileInput.disabled = false;
        }
        if (elements.browseBtn) {
          elements.browseBtn.disabled = false;
          elements.browseBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
        if (elements.dropArea) {
          elements.dropArea.classList.remove('opacity-50', 'cursor-not-allowed');
        }
      } else {
        statusElement.innerHTML = `
          <div class="flex items-center text-red-600">
            <i class="fas fa-exclamation-triangle mr-2"></i>
            Please select a country code before uploading files
          </div>
        `;
        statusElement.className = 'mt-2 text-sm';

        // Disable file upload
        if (elements.fileInput) {
          elements.fileInput.disabled = true;
        }
        if (elements.browseBtn) {
          elements.browseBtn.disabled = true;
          elements.browseBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (elements.dropArea) {
          elements.dropArea.classList.add('opacity-50', 'cursor-not-allowed');
        }
      }
    }
  };

  // Public API
  return {
    init: init,
    showToast: showToast,
    addActivityLog: addActivityLog
  };
})();

// Initialize the application when the DOM is fully loaded
window.addEventListener('DOMContentLoaded', function() {
  WhatsAppBulkSender.init();
});
