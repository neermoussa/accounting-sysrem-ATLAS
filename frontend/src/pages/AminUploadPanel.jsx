import { useRef, useState } from 'react';
import { api } from '../api.js';
import ImportReview from '../components/ImportReview.jsx';
import UploadHistoryTable from '../components/UploadHistoryTable.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/import.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function AminUploadPanel() {
  const { t } = useLanguage();
  const [step, setStep] = useState('upload'); // upload | mapping | review
  const [reportDate, setReportDate] = useState(todayStr());
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null); // { batchId, columns, sampleRows, savedMapping, filename }
  const [phoneColumn, setPhoneColumn] = useState('');
  const [balanceColumn, setBalanceColumn] = useState('');
  const [saveAsDefault, setSaveAsDefault] = useState(true);
  const [staging, setStaging] = useState(false);
  const [reviewData, setReviewData] = useState(null);
  const [error, setError] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const fileInputRef = useRef(null);

  async function handleFileChosen(file) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const result = await api.uploadImport(file, reportDate);
      setUploadResult(result);
      setHistoryRefresh((n) => n + 1);
      if (result.savedMapping) {
        // apply the saved mapping automatically, skip asking about columns again
        await applyMapping(result.batchId, result.savedMapping.phone_column, result.savedMapping.balance_column, false);
      } else {
        setPhoneColumn(result.columns[0] || '');
        setBalanceColumn(result.columns[1] || '');
        setStep('mapping');
      }
    } catch (err) {
      setError(err.detail?.error === 'empty_file' ? t('aminUpload.errorEmptyFile') : t('aminUpload.errorUploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  async function applyMapping(batchId, phoneCol, balanceCol, saveDefault) {
    setStaging(true);
    setError(null);
    try {
      const review = await api.stageImportBatch(batchId, {
        phone_column: phoneCol,
        balance_column: balanceCol,
        save_as_default: saveDefault,
      });
      setReviewData(review);
      setStep('review');
    } catch (err) {
      setError(t('aminUpload.errorMappingFailed'));
    } finally {
      setStaging(false);
    }
  }

  function resetAll() {
    setStep('upload');
    setUploadResult(null);
    setReviewData(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="uploads-tab-panel">
      {step === 'upload' && (
        <div className="card import-upload-card">
          <p className="import-hint">{t('aminUpload.hint')}</p>

          <label className="import-field">
            {t('aminUpload.reportDate')}
            <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
          </label>

          <label className="import-dropzone">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => handleFileChosen(e.target.files?.[0])}
              disabled={uploading}
            />
            <span>{uploading ? t('aminUpload.uploading') : t('aminUpload.chooseFile')}</span>
          </label>

          {error && <p className="qof-error">{error}</p>}
        </div>
      )}

      {step === 'mapping' && uploadResult && (
        <div className="card import-mapping-card">
          <h2>{t('aminUpload.firstUploadTitle')}</h2>
          <p className="import-hint">
            {t('aminUpload.mappingHintPrefix')} <strong>{uploadResult.filename}</strong> {t('aminUpload.mappingHintMiddle')} {uploadResult.rowCount} {t('aminUpload.mappingHintSuffix')}
          </p>

          <div className="import-mapping-selects">
            <label>
              {t('aminUpload.phoneColumn')}
              <select value={phoneColumn} onChange={(e) => setPhoneColumn(e.target.value)}>
                {uploadResult.columns.map((col) => (
                  <option key={col} value={col}>
                    {col || t('aminUpload.noHeader')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('aminUpload.balanceColumn')}
              <select value={balanceColumn} onChange={(e) => setBalanceColumn(e.target.value)}>
                {uploadResult.columns.map((col) => (
                  <option key={col} value={col}>
                    {col || t('aminUpload.noHeader')}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="import-sample-table-wrap">
            <table className="import-sample-table">
              <thead>
                <tr>
                  {uploadResult.columns.map((col) => (
                    <th
                      key={col}
                      className={
                        (col === phoneColumn ? 'col-phone ' : '') + (col === balanceColumn ? 'col-balance' : '')
                      }
                    >
                      {col || '—'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploadResult.sampleRows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell === null ? '' : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="import-checkbox">
            <input type="checkbox" checked={saveAsDefault} onChange={(e) => setSaveAsDefault(e.target.checked)} />
            {t('aminUpload.saveDefaultLabel')}
          </label>

          {error && <p className="qof-error">{error}</p>}

          <div className="qof-actions">
            <button type="button" className="ghost-btn" onClick={resetAll} disabled={staging}>
              {t('aminUpload.cancel')}
            </button>
            <button
              type="button"
              className="gold-btn qof-save"
              disabled={staging || !phoneColumn || !balanceColumn}
              onClick={() => applyMapping(uploadResult.batchId, phoneColumn, balanceColumn, saveAsDefault)}
            >
              {staging ? t('aminUpload.matching') : t('aminUpload.confirmContinue')}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && reviewData && (
        <ImportReview
          initialData={reviewData}
          onDataChange={setReviewData}
          onCommitted={() => {}}
          onStartOver={resetAll}
        />
      )}

      <UploadHistoryTable fetchFn={api.listImportBatches} refreshSignal={historyRefresh} />
    </div>
  );
}
